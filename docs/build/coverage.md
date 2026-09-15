# Coverage ledger

Maps every specification, screen and required flow to implementation and verification evidence. Status values: Not started, In progress, Implemented (code exists, not yet verified), Verified (tests or rendered evidence recorded), Blocked (reason given). Keep this current; do not mark Verified without evidence.

## Specifications

| Note | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| [01_product.md](../notes/files/01_product.md) | Not started | | |
| [02_themes.md](../notes/files/02_themes.md) | Not started | | |
| [03_access_and_billing.md](../notes/files/03_access_and_billing.md) | Not started | | |
| [04_beta_access.md](../notes/files/04_beta_access.md) | Not started | | |
| [05_vault.md](../notes/files/05_vault.md) | Not started | | |
| [06_document_tools.md](../notes/files/06_document_tools.md) | Not started | | |
| [07_architecture.md](../notes/files/07_architecture.md) | Not started | | |
| [08_self_hosting.md](../notes/files/08_self_hosting.md) | Not started | | |
| [09_research.md](../notes/files/09_research.md) | Background only | | |
| [10_original_list.md](../notes/files/10_original_list.md) | Background only | | |
| [11_document_versioning.md](../notes/files/11_document_versioning.md) | Not started | | |
| [12_simon_meta_tools.md](../notes/files/12_simon_meta_tools.md) | Not started | | |
| [13_keyboard_shortcuts.md](../notes/files/13_keyboard_shortcuts.md) | Not started | | |
| [14_search.md](../notes/files/14_search.md) | Not started | | |
| [15_deadlines_reminders_calendar.md](../notes/files/15_deadlines_reminders_calendar.md) | Not started | | |
| [16_simon_handoffs_and_artifact_sharing.md](../notes/files/16_simon_handoffs_and_artifact_sharing.md) | Not started | | |
| [17_analytics.md](../notes/files/17_analytics.md) | Not started | | |
| Note 18: quick chat (to be written, decision D1 in [decisions](decisions.md)) | Not started | | |

## Screen briefs

| Screen | Status | Implementation | Evidence |
| --- | --- | --- | --- |
| [about](../../design/mockups/about.md) | Not started | | |
| [access_revoked](../../design/mockups/access_revoked.md) | Not started | | |
| [admin_accounts](../../design/mockups/admin_accounts.md) | Not started | | |
| [admin_activity](../../design/mockups/admin_activity.md) | Not started | | |
| [admin_invite_create](../../design/mockups/admin_invite_create.md) | Not started | | |
| [admin_invites](../../design/mockups/admin_invites.md) | Not started | | |
| [agent_approval](../../design/mockups/agent_approval.md) | Not started | | |
| [agent_connections](../../design/mockups/agent_connections.md) | Not started | | |
| [archive](../../design/mockups/archive.md) | Not started | | |
| [artifact_share](../../design/mockups/artifact_share.md) | Not started | | |
| [artifact_shares](../../design/mockups/artifact_shares.md) | Not started | | |
| [artifact_viewer](../../design/mockups/artifact_viewer.md) | Not started | | |
| [beta_gate](../../design/mockups/beta_gate.md) | Not started | | |
| [calendar](../../design/mockups/calendar.md) | Not started | | |
| [command_palette](../../design/mockups/command_palette.md) | Not started | | |
| [connections](../../design/mockups/connections.md) | Not started | | |
| [document_history](../../design/mockups/document_history.md) | Not started | | |
| [email_entry](../../design/mockups/email_entry.md) | Not started | | |
| [email_otp](../../design/mockups/email_otp.md) | Not started | | |
| [handoff](../../design/mockups/handoff.md) | Not started | | |
| [keyboard_shortcuts](../../design/mockups/keyboard_shortcuts.md) | Not started | | |
| [notifications](../../design/mockups/notifications.md) | Not started | | |
| [onboarding_connections](../../design/mockups/onboarding_connections.md) | Not started | | |
| [onboarding_name](../../design/mockups/onboarding_name.md) | Not started | | |
| [profile_menu](../../design/mockups/profile_menu.md) | Not started | | |
| [search](../../design/mockups/search.md) | Not started | | |
| [settings_account](../../design/mockups/settings_account.md) | Not started | | |
| [settings_appearance](../../design/mockups/settings_appearance.md) | Not started | | |
| [settings_notifications](../../design/mockups/settings_notifications.md) | Not started | | |
| [signup_confirmation](../../design/mockups/signup_confirmation.md) | Not started | | |
| [system_states](../../design/mockups/system_states.md) | Not started | | |
| [task_actions](../../design/mockups/task_actions.md) | Not started | | |
| [task_chat](../../design/mockups/task_chat.md) | Not started | | |
| [task_document](../../design/mockups/task_document.md) | Not started | | |
| [task_schedule](../../design/mockups/task_schedule.md) | Not started | | |
| [transactional_emails](../../design/mockups/transactional_emails.md) | Not started | | |
| [vault_item_editor](../../design/mockups/vault_item_editor.md) | Not started | | |
| [vault_items](../../design/mockups/vault_items.md) | Not started | | |
| [vault_reset](../../design/mockups/vault_reset.md) | Not started | | |
| [vault_setup](../../design/mockups/vault_setup.md) | Not started | | |
| [vault_unlock](../../design/mockups/vault_unlock.md) | Not started | | |
| [workspace_later](../../design/mockups/workspace_later.md) | Not started | | |
| [workspace_now](../../design/mockups/workspace_now.md) | Not started | | |
| [workspace_unclassified](../../design/mockups/workspace_unclassified.md) | Not started | | |
| quick_chat (new brief, decision D1) | Not started | | |
| cookie_consent (decision D5) | Not started | | |
| mcp_oauth_consent (decision D4) | Not started | | |

## End-to-end flows

| Flow | Status | Test | Evidence |
| --- | --- | --- | --- |
| Signup consent → OTP → locked gate → manual invite → onboarding → first task | Not started | | |
| Existing account OTP login and access-state routing (unlocked, locked, relocked, suspended) | Not started | | |
| Edit page → saved → history → compare → restore as new commit | Not started | | |
| Concurrent edit conflict → review → keep draft | Not started | | |
| Simon reads a section → edits a section → page updates | Not started | | |
| Simon connector action → exact-argument approval → per-action outcome | Not started | | |
| Quick chat → save as task → end → 24-hour expiry | Not started | | |
| Drag Now → Later with Undo; keyboard Move to | Not started | | |
| Complete → archive → restore to original collection | Not started | | |
| Keyboard-only journey (note 13 acceptance) | Not started | | |
| Command palette and full search (scopes, archive/chat opt-in, jump to section) | Not started | | |
| Style × accent × mode switching preserves drafts and running chat | Not started | | |
| Vault setup → unlock → item → reset via OTP → re-unlock | Not started | | |
| Deadline → calendar reschedule → reminder at top of hour → notification → snooze → complete | Not started | | |
| Handoff prompt → snapshot review → expiring link → signed-out HTML and raw read → revoke/expire | Not started | | |
| Password and public share variants; relock disables grants | Not started | | |
| Admin generates invites → copy once → redemption → relock → restore | Not started | | |
| Incoming MCP via bearer key and OAuth 2.1; relock blocks calls | Not started | | |
| Cookie consent → analytics events allowlisted; decline sends nothing | Not started | | |
| Both executors (Nest local and Trigger) pass the same agent, tool and scheduling contracts | Not started | | |

## Cross-cutting checks

| Check | Status | Evidence |
| --- | --- | --- |
| Typecheck, lint, production builds, clean install | Not started | |
| D1 migrations apply cleanly; atomic conditional batch behavior | Not started | |
| Encryption: AES-256-GCM with AAD, nonce/key versioning, wrong-key and tamper failures | Not started | |
| Cross-user access, relock bypass, replay, stale revision rejection | Not started | |
| Secret, token and content leakage (logs, analytics, caches, referrers) | Not started | |
| Interrupted execution and uncertain external outcomes | Not started | |
| Missing configuration handled at startup | Not started | |
| Accessibility: focus order, dialogs, contrast, reduced motion, screen-reader labels | Not started | |
| Responsive rendering at 1440, 1024 and 390 px compared with the UI sample | Not started | |
| Live integration checks (D1, R2, Resend, OpenAI, Composio, Trigger, PostHog) run with credentials | Not started | |
