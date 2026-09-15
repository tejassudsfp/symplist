# symplist — product direction

Updated September 14, 2026. Design brief; application implementation has not started.

Each task is a chattable, executable unit with one persistent conversation and an editable Markdown page.

The agent is named **Simon**. Simon discovers capabilities and connections through a small meta-tool layer and follows domain-specific rules. See [Simon meta tools and rules](12_simon_meta_tools.md) for the proposed initial contract.

## Current layout

Use [shadcn sidebar-09](https://ui.shadcn.com/view/new-york-v4/sidebar-09) as the navigation reference. Its [component source](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/blocks/sidebar-09/components/app-sidebar.tsx) combines a fixed icon sidebar with an adjacent list panel; clicking a navigation icon opens the panel.

Adapt that interaction to four desktop regions:

| Region | Purpose |
| --- | --- |
| Icon rail | Now, Later, Unclassified; always available with accessible names and tooltips. |
| Task inbox | Selected list, quick add, search, task rows, expandable sublists. |
| Main page | Selected task title, completion control, editable Markdown document. |
| Right chat | For AI-enabled users: the selected task's conversation, agent activity, tool results, and composer. Available to all unlocked beta accounts. |

This replaces the earlier two-section homepage and sliding task sheet. The page and conversation are visible together on wide screens.

## Task interactions

- Clicking Now, Later, or Unclassified opens that task inbox beside the icon rail.
- Clicking a task selects its page and its conversation together. Switching tasks must never attach a message or agent edit to the wrong task.
- New task entry needs only a title. Proposed default: inline creation uses the current list; unsorted external capture uses Unclassified.
- Drag tasks onto rail destinations to move between lists. Provide a Move to menu for keyboard and touch use.
- Support expandable sublists/subtasks. Proposed default: moving a parent carries its descendants; independent child moves and parent completion behavior need definition before implementation.
- Both the user and the agent can write the Markdown page. Preserve actual Git commit history in encrypted R2 bundles indexed and published through D1, and handle concurrent edits without silently overwriting either writer. Agents query mechanically generated section changes and bounded diffs since their last read; no background summarization runs. See [document versioning](11_document_versioning.md).
- Completion sends the task to Archive, preserving its page and conversation. Archive is a separate view with restore support.

## Keeping the workspace simple

Proposed refinements: resizable inbox and chat panels, both collapsible; a collapsed chat becomes a small right-corner control. On narrow screens, show one primary surface at a time with explicit navigation between list, page, and chat.

Keep task rows compact: title, optional short preview, and a subtle activity indicator when needed. Avoid mandatory tags, estimates, or priority configuration.

Retain the requested top-left profile control with Settings and Connections, with Vault beside it. Provide an Archive entry in navigation or the profile menu; its exact placement remains open.

## Capabilities carried forward

- Settings offers complete visual themes, each with Light, Dark, and System mode support. Themes change typography, spacing, shapes, component styling, and panel treatment as well as colors. See [THEMES.md](02_themes.md).
- Agent execution through tools and Composio connections, with action previews and appropriately scoped permissions.
- An incoming MCP interface for third-party agents to create and interact with authorized tasks.
- Vault for secret keys and sensitive notes. On first access, users set a custom vault key; later access requires that key. Reset requires a fresh email OTP through Resend and preserves existing contents through managed key recovery. See [VAULT.md](05_vault.md).
- Encrypted storage for all content. The vault has a service-managed recovery path; agent access remains explicit. Detailed key custody and encrypted search implementation remain to be designed.
- Confirmed stack: Next.js frontend, NestJS backend, Cloudflare D1 database, R2 objects, Vercel AI SDK agent loop, Composio connections/tools, and optional Trigger.dev durable sessions. Multi-user from the start; no code-execution sandboxes. See [ARCHITECTURE.md](07_architecture.md).
- Automations can be added later; Unclassified provides a home for incoming tasks that have not been sorted.

The core interaction to validate is: capture a task, open its page, ask the agent for help, see useful work appear, and complete or move the task without losing context.

Symplist is open source under the [MIT License](../../../LICENSE), copyright 2026 [Tejas Parthasarathi Sudarshan](https://tejassuds.com).

## Accounts, beta access, and context

Email lookup leads to OTP login for existing users; new users consent to account creation before OTP. Verified accounts remain locked until a beta code is redeemed or an administrator unlocks them. Only then does onboarding collect name and offer skippable connectors. All configured features, including AI/chat, are free for unlocked beta users. No payment, plan selection, subscription tier monitoring, or weekly paid quota runs during beta. Administrators manage invite generation, redemption capacity, and account access. See [ACCESS-AND-BILLING.md](03_access_and_billing.md) and [BETA-ACCESS.md](04_beta_access.md).

Self-hosted operators can disable the invite requirement while retaining authentication and ownership checks; see [SELF-HOSTING.md](08_self_hosting.md).

Agents explore task documents through section-based MCP tools with outline/search/read operations; whole documents are never automatically loaded into the prompt. See [DOCUMENT-TOOLS.md](06_document_tools.md).

## Keyboard-first use and search

Keyboard navigation covers collections, next/previous tasks, Page/Chat focus, editing, movement, completion, search, and settings. A shared command palette and searchable/remappable shortcut reference make actions discoverable. Unmodified navigation keys never fire while typing. See [keyboard shortcuts](13_keyboard_shortcuts.md).

Search includes a quick task switcher, full task/document search with opt-in archive/chat scopes, and find within the current surface. Match ranking, bounded snippets, section navigation, and encrypted index freshness are required; no model call is needed. Vault search stays isolated. See [search](14_search.md).

## Optional deadlines and reminders

Tasks support optional date-only/timed deadlines and reminders through in-app notifications or Resend email, plus Month/Week/Agenda calendar views. Deadlines never automatically change Now/Later/Unclassified placement. Quiet hours, snooze, and timezone-aware delivery keep reminders calm. See [the complete specification](15_deadlines_reminders_calendar.md).

## Simon facilitates specialist work

Simon supports task productivity, small authorized actions, and specialist handoffs; it is not a general-purpose chatbot, coding agent, or deep-research agent. Build handoff mode with editable full instructions and explicitly released read-only artifact links. See [the authoritative role and sharing specification](16_simon_handoffs_and_artifact_sharing.md).
