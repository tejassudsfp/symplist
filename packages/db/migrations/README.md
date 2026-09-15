# Migrations

SQL migrations for Cloudflare D1 and the local `node:sqlite` stand-in, applied in lexical order by the migration runner (architecture §3.4). The runner records applied files in `d1_migrations`, sending one request per file containing the file plus its `d1_migrations` insert.

Files are named `NNNN_name.sql`. Each owner writes only inside its range:

| Range | Owner | Tables |
| --- | --- | --- |
| `0001`–`0019` | Foundation | `users`, `auth_sessions`, `account_keys`, `otp_challenges`, `otp_limits`, `idempotency_records`, `dispatch_intents`, `executor_state`, `webhook_receipts`, `beta_admin_events`, `tasks`, `user_preferences`, `search_intents`, `account_delete_authorizations`, `account_deletions`, `account_tombstones` |
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

No SQL files exist yet: the foundation migrations are written in Phase C3.
