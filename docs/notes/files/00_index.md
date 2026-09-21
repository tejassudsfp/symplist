# Symplist notes — reading order

Product decisions and implementation specifications. The application is not implemented yet. Current launch scope is a free closed beta with manually shared invites; earlier paid-plan ideas are deferred.

| Order | Document | Purpose |
| --- | --- | --- |
| 01 | [Product](01_product.md) | Workspace, task interactions, and current scope |
| 02 | [Themes](02_themes.md) | Appearance preferences and theme architecture |
| 03 | [Access and deferred billing](03_access_and_billing.md) | Signup consent, OTP, onboarding, and beta flags |
| 04 | [Beta access](04_beta_access.md) | Manual invite generation, redemption, and administration |
| 05 | [Vault](05_vault.md) | Key setup, unlock, and OTP recovery |
| 06 | [Document tools](06_document_tools.md) | Section-based MCP reading and editing |
| 07 | [Architecture](07_architecture.md) | Stack, execution modes, persistence, and open choices |
| 08 | [Self-hosting](08_self_hosting.md) | Deployment preparation; runnable instructions pending implementation |
| 09 | [Original research](09_research.md) | Background comparison of list methods |
| 10 | [Original list exercise](10_original_list.md) | Historical Today/Later template, not current app navigation |
| 11 | [Document versioning](11_document_versioning.md) | Actual Git build specification: encrypted R2 bundles, D1 publication, and deterministic change retrieval |
| 12 | [Simon meta tools and rules](12_simon_meta_tools.md) | Composio meta-tool wrappers, native tools, and rule domains |
| 13 | [Keyboard shortcuts](13_keyboard_shortcuts.md) | Action registry, proposed bindings, contexts, remapping, and accessibility |
| 14 | [Search](14_search.md) | Quick switcher, full search, ranking, encrypted indexing, and freshness |
| 15 | [Deadlines, reminders, and calendar](15_deadlines_reminders_calendar.md) | Time semantics, notifications, deterministic scheduling, and delivery |
| 16 | [Simon handoffs and artifact sharing](16_simon_handoffs_and_artifact_sharing.md) | Facilitator scope, specialist prompts, encrypted snapshots, and read-only grants |
| 17 | [Product analytics](17_analytics.md) | PostHog event allowlist, privacy, consent, and configuration |


The notes preserve current decisions; the design briefs expand them into visual states and explicitly mark new assumptions. No payment or automatic-invite flows belong in beta. Direct Trigger-to-browser output remains an evaluated alternative, not a confirmed replacement for backend delivery.
