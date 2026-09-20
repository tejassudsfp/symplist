# Migrations

SQL migrations for Cloudflare D1 and the local `node:sqlite` stand-in, applied in lexical order by the migration runner (architecture §3.4). The runner records applied files in `d1_migrations`, sending one request per file containing the file plus its `d1_migrations` insert.

Files are named `NNNN_name.sql`. Each owner writes only inside its range:

| Range | Owner | Tables |
| --- | --- | --- |
| `0001`–`0019` | Foundation | `users`, `auth_sessions`, `account_keys`, `otp_challenges`, `otp_limits`, `idempotency_records`, `dispatch_intents`, `executor_state`, `webhook_receipts`, `beta_admin_events`, `tasks`, `user_preferences`, `search_intents`, `account_delete_authorizations`, `account_deletions`, `account_tombstones`, `abuse_counters` |
| `0100`–`0199` | Access | `beta_invites`, `beta_redemptions`, `beta_access_grants` |
| `0200`–`0299` | Workspace | Workspace-owned additions to the foundation tables |
| `0300`–`0399` | Documents | `doc_repos`, `doc_commits`, `doc_publish_requests`, `doc_drafts`, `read_receipts` |
| `0400`–`0499` | Search and keyboard | `search_indexes` |
| `0500`–`0599` | Simon | `conversations`, `messages`, `message_parts`, `runs`, `approvals`, `user_asks`, `tool_invocations` |
| `0600`–`0699` | Scheduling | `task_schedules`, `reminders`, `reminder_occurrences`, `notification_outbox`, `notifications`, `notification_prefs`, `email_suppressions`, `schedule_audit` |
| `0700`–`0799` | Vault | `vaults`, `vault_items`, `vault_sessions`, `vault_reset_authorizations`, `vault_unlock_limits`, `vault_grants` |
| `0800`–`0899` | Sharing | `artifacts`, `share_grants`, `share_sessions`, `share_approvals`, `share_audit`, `share_limits` |
| `0900`–`0999` | Connections and MCP | `connections`, `connection_attempts`, `composio_sessions`, `composio_auth_configs`, `mcp_grants`, `oauth_clients`, `oauth_requests`, `oauth_codes`, `oauth_refresh_tokens` |
| `1000`–`1099` | Analytics and consent | Analytics consent and `analytics_id` are columns on `users` (foundation) |

Rules:

- **Expand-only.** Add tables, nullable or defaulted columns, indexes and triggers. Drops, renames and tightened constraints ship in a later release, after the api, worker and web all run code that no longer needs the old shape.
- **`STRICT` tables** everywhere. Ids are UUIDv7 strings; list order uses fractional `position` strings.
- A migration depends only on files already merged to `main`, and a merged file never changes (CI fails if it does). The runner logs any file applied out of order.
- The CI `migrate` job applies migrations before the Trigger deploy; Render's pre-deploy step runs the same idempotent runner; local development applies them on api startup; tests apply them to `node:sqlite`.

Running and checking migrations:

- `pnpm db:migrate` applies pending files (`--driver d1|local` or `DATA_DRIVER`; `--database <path>` for the local SQLite file, default `.local-data/d1.sqlite`; `--dir <path>` for another directory). The D1 driver reads `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` and `CLOUDFLARE_D1_MIGRATE_API_TOKEN` (CI) or `CLOUDFLARE_D1_API_TOKEN` (Render pre-deploy). After a build, `node packages/db/dist/cli/migrate.js` runs the same CLI.
- `node scripts/check-migrations.mjs` fails when a file already on `origin/main` was modified or deleted; CI runs it with `--fetch`.
- The `d1_migrations` table is wrangler's own definition (not `STRICT`), so `wrangler d1 migrations list --remote` reads it.
- A migration never contains `BEGIN`/`COMMIT`: each file already runs as one request (one transaction locally). Keep every statement under 100 KB.
- `"group"` in `user_preferences` is an SQL keyword and must be quoted.
