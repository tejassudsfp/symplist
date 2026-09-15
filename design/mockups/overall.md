# Symplist — complete UI design prompt for the design tool

The product and technical source notes are organized in [docs/notes/files/00_index.md](../../docs/notes/files/00_index.md). Read the current product, beta, vault, and theme notes if additional context is needed.

Use this file as the master prompt. Read every linked screen brief and [themes.md](themes.md) before designing. Create the actual mockups, reusable components, and connected prototype requested below, rather than returning only a written design proposal.

## Your assignment

Design the complete interface for **symplist**, a calm, personal task workspace where each task has an editable Markdown document and one persistent AI conversation. Produce high-fidelity mockups for every screen and material state in this folder, along with a family of complete visual themes. The intended result is implementable in Next.js with shadcn-style accessible components.

The founding idea is: **“The most productive thing is often the most simple.”** The user finds maintaining task systems overwhelming. Make capture immediate, navigation obvious, and deeper capabilities available when needed. This is capable software with a little warmth and personality. It should feel refreshing, quietly delightful, and subtly cute. Keep productive work visually dominant.

Design standard and slightly quirky themes. Avoid turning every surface into a card, dashboard, illustration, mascot, gradient, badge, or productivity score. Whimsy belongs in small details: a selected marker, a corner shape, a gently unusual empty-state illustration. Never decorate every task row. Serious moments such as access errors, approvals, and vault resets use straightforward language.

## Product rules — authoritative for this design

- **Closed beta, entirely free for admitted users.** No pricing screen, upgrade button, Free/Pro label, credit balance, weekly quota meter, billing onboarding, checkout, or subscription settings.
- Anyone can register. Email verification establishes identity; it does not grant beta access.
- Existing email → OTP → login. Unknown email → ask permission to create account → pending account → OTP verification.
- Verified but locked accounts see the invite gate. **The owner generates and privately shares invite codes manually. Signup never sends an invite code.** Do not add “Email me an invite,” a waitlist position, referral rewards, or an automatic admission promise.
- A valid manually shared code or administrator unlock grants access. Then ask for name and offer skippable connectors. No mandatory theme selection during onboarding.
- Every admitted user can use all configured features, including AI. Fast and Smart are model choices, never payment plans.
- The application opens in the task workspace, with no analytics dashboard or home marketing page between the user and their list.
- Each task has one persistent conversation and one Markdown page. Selecting a different task switches both together.
- The assistant is named **Simon**. Use Simon in the chat header and agent attribution. Meta tools/rules operate behind the interface; show concise human-readable activity and connection/question prompts, not a new meta-tool dashboard.
- No sandboxes, terminals, code-execution panels, or filesystem explorer. The agent uses application tools and connected services.
- Document versions are backed by actual Git, with encrypted bundles stored in R2 and indexed by D1. Keep this infrastructure out of normal UI: History, Compare, and Restore are sufficient. Restore adds a revision; it does not erase history or undo external actions.
- Task context is explored section by section through tools. Show concise activity such as “Reading Requirements”; no automatic giant document dump or hidden chain-of-thought transcript.
- Vault: users set a custom key on first access. Unlock by entering it. Reset with a fresh email OTP and a new key, preserving contents through service-managed recovery. Do not claim “Only you can decrypt this” or blanket end-to-end encryption.
- Theme/style, accent color, and brightness are three independent preferences. Every style supports every preset and a custom accent. Every theme has Light and Dark variants; System follows device brightness within that theme.
- MIT open source by **Tejas Parthasarathi Sudarshan**, **tejassuds.com**. Use attribution in About/footer contexts, not as a watermark across the workspace.

These rules supersede older two-column-homepage, sliding-task-sheet, and paid-plan ideas. Future billing and general automation builders are outside this mockup scope. Optional deadlines, scheduled reminders, notifications, and the internal calendar are in scope; follow [the scheduling specification](../../docs/notes/files/15_deadlines_reminders_calendar.md).

## Layout reference and information architecture

Reference: https://ui.shadcn.com/view/new-york-v4/sidebar-09. Borrow its persistent icon rail plus adjacent inbox panel interaction. Do not copy its email content or force email fields onto tasks.

Desktop hierarchy:

1. A restrained top bar: profile control at top left, Vault next to it. Preserve this explicit placement. The profile menu contains Settings, Connections, Calendar, Archive, About, and Sign out; administrators also get Beta administration.
2. Narrow icon rail: **Now, Later, Unclassified**. Clear active marker, focus treatment, and hover/focus labels. Use recognizable differentiated icons.
3. Inbox panel for the selected collection: label, quiet search, quick task entry, expandable sublists, selectable task rows.
4. Main document area: task title, completion, small task menu, editable Markdown. This is the primary work surface.
5. Right chat panel for the selected task: conversation, compact agent activity, Fast/Smart selector, composer, stop/approval states. Collapse to a corner control when desired.

Suggested starting proportions at 1440 px: rail about 56 px; inbox about 280 px; chat about 340 px; document takes the remainder. These are design starting points, not inflexible dimensions. Keep the document readable and make side panels collapsible/resizable. At laptop widths prefer collapsing a panel to squeezing the document into an unusable strip.

On mobile, present one primary surface at a time. A compact Now/Later/Unclassified selector replaces the wide rail/inbox arrangement; selecting a task opens its Page, with a visible Chat switch and a clear return to the list. Preserve drafts and task identity. Do not compress four desktop columns onto a phone. Keep profile and Vault readily accessible in the compact top bar.

## Theme assignment

Design four complete themes: two grounded and two subtly quirky. Follow [themes.md](themes.md). They must differ in typography, density, geometry, panel treatment, and component styling, not merely accent color.

Keep workflows, semantics, icon meaning, control locations, and accessibility consistent. Every theme includes both light and dark treatments. System is a behavior, not a ninth visual theme. Accent is chosen independently using presets or a custom color; theme changes preserve it. Follow the extra accent comparison boards and contrast rules in themes.md.

## Required screen briefs

### Identity and admission

- [email_entry.md](email_entry.md)
- [signup_confirmation.md](signup_confirmation.md)
- [email_otp.md](email_otp.md)
- [beta_gate.md](beta_gate.md)
- [access_revoked.md](access_revoked.md)
- [onboarding_name.md](onboarding_name.md)
- [onboarding_connections.md](onboarding_connections.md)

### Daily workspace

- [workspace_now.md](workspace_now.md)
- [workspace_later.md](workspace_later.md)
- [workspace_unclassified.md](workspace_unclassified.md)
- [task_actions.md](task_actions.md)
- [task_schedule.md](task_schedule.md)
- [calendar.md](calendar.md)
- [notifications.md](notifications.md)
- [task_document.md](task_document.md)
- [document_history.md](document_history.md)
- [task_chat.md](task_chat.md)
- [handoff.md](handoff.md)
- [artifact_share.md](artifact_share.md)
- [artifact_viewer.md](artifact_viewer.md)
- [artifact_shares.md](artifact_shares.md)
- [agent_approval.md](agent_approval.md)
- [archive.md](archive.md)
- [search.md](search.md)
- [command_palette.md](command_palette.md)

### Settings and connections

- [profile_menu.md](profile_menu.md)
- [settings_account.md](settings_account.md)
- [settings_notifications.md](settings_notifications.md)
- [settings_appearance.md](settings_appearance.md)
- [keyboard_shortcuts.md](keyboard_shortcuts.md)
- [connections.md](connections.md)
- [agent_connections.md](agent_connections.md)
- [about.md](about.md)

### Vault

- [vault_setup.md](vault_setup.md)
- [vault_unlock.md](vault_unlock.md)
- [vault_items.md](vault_items.md)
- [vault_item_editor.md](vault_item_editor.md)
- [vault_reset.md](vault_reset.md)

### Administration and supporting surfaces

- [admin_invites.md](admin_invites.md)
- [admin_invite_create.md](admin_invite_create.md)
- [admin_accounts.md](admin_accounts.md)
- [admin_activity.md](admin_activity.md)
- [system_states.md](system_states.md)
- [transactional_emails.md](transactional_emails.md)

## Deliverables and coverage

1. Design every listed screen and its specified significant states in Studio Light. Create a screen index linking frames to these filenames.
2. Produce paired light/dark token sheets and component sheets for all four themes. Show buttons, inputs, selected/hover/focus states, task rows, typography, panel framing, Markdown, chat, approval cards, and errors in each.
3. For all eight theme/mode combinations, render the same populated workspace, task document/chat, Appearance settings, and vault-items screen using identical sample data. This makes structural differences directly comparable.
4. Cover the remaining screen families in Studio Dark: identity, onboarding, archive, connections, vault reset, and administration. Bind all components to the theme system so the full application can render in every theme; explicitly identify anything not rendered as a separate frame. Do not imply unrendered coverage is finished.
5. Mobile frames at about 390 px: email/OTP, beta gate, onboarding, list, document, chat, approval, appearance, connections, vault unlock/items/reset. Add a constrained desktop/tablet example around 1024 px. Desktop default is around 1440 px.
6. Prototype: new signup → OTP → locked gate → invite → onboarding → first task; open task → chat reads a section → agent proposes an edit → page updates; drag Now → Later; complete → archive → restore; theme switch; vault setup/unlock/reset; admin creates a code → copies it for manual sharing.
7. Provide implementation handoff notes: semantic tokens, type scale, spacing, borders/radii, layer hierarchy, component variants, responsive rules, focus order, and restrained motion/reduced-motion alternatives. Specify font names and distributable alternatives.
8. Annotate each frame with entry, primary action, exit, persistence expectations, and state transitions. Name frames `screen / state / theme / mode / viewport`.

Use reusable components, variables, and variants where your environment supports them. If it cannot produce native design files, deliver a navigable visual prototype and an exported frame index with equivalent coverage. Do not substitute a collage or written description for the mockups.

## Content and microcopy

Use a coherent fictional dataset throughout: Maya Rao, maya@example.com; tasks “Plan a quiet weekend,” “Refresh my portfolio,” “Book a bike tune-up,” “Try the pottery class,” and “Send the project outline.” Task documents contain concrete headings, short paragraphs, lists, and occasional code/Markdown examples.

Prefer ordinary verbs: Add task, Move to Later, Connect, Skip for now, Unlock vault. Use sentence case. Avoid guilt about unfinished tasks, streaks, urgency theater, confetti, and excessive emoji. “Nothing here yet” is sufficient; one small theme-specific illustration is optional.

All keys, codes, tokens, provider accounts, and financial-looking information must be clearly fictional. Mask secrets. Prototype invite examples must be marked nonfunctional; never invent working service URLs or public repository links. User-owned private content must not appear in admin mockups.

## Accessibility and interaction quality

Aim for WCAG 2.2 AA: readable text/controls, visible keyboard focus, sufficient contrast, comfortable targets, no color-only statuses, labeled icon controls, and reduced-motion support. Design for long names, zoomed text, keyboard-only use, and empty/loading/error states. Use a single real OTP input visually styled as cells if desired; support paste and autofill.

For modal dialogs, show focus containment, escape behavior, and return focus. Dragging always has a Move to alternative. Async operations distinguish submitting, accepted, running, saving, saved, interrupted, and failed. Do not display success before an action is confirmed. Theme changes and navigation must preserve drafts and running work.

## Final review

Deliver a coverage checklist against all 44 screen briefs. Confirm there are no automatic invite emails, pricing surfaces, quota meters, forced connectors, terminal/sandbox controls, false encryption promises, or theme variants that only recolor the interface. Any unresolved behavior must be called out as a design assumption rather than silently changed.

## Keyboard and search requirements

Use the shared [keyboard map](../../docs/notes/files/13_keyboard_shortcuts.md) and [search specification](../../docs/notes/files/14_search.md) across every relevant screen. Show shortcuts in menus/tooltips, explicit focus, next/previous task navigation, Page/Chat transitions, Mod+K, scoped find, and context-aware typing behavior. Include a working keyboard-only prototype path and searchable/remappable help; do not merely label inactive buttons with keycaps. Search results must open the correct task section/message and state their scope. Full search defaults to active task titles/current documents; archive and chat are opt-in. No global vault results.

## Scheduling prototype coverage

Prototype task → optional deadline/reminder → calendar → reschedule → in-app notification → snooze → complete. Include reminder settings and generic reminder email. Add mobile calendar/agenda, notification center, and deadline editor frames. Preserve top-left profile and Vault; add a restrained notification control. Show quiet hours, timezone/DST validation, missed reminders, cancellation, and save conflicts. Calendar and reminder commands must work through the shared command palette.

## Supplied visual foundation

Use [the user-selected UI sample](<../UI sample/README.md>) as the visual foundation. Derive missing screens from its component language while fulfilling every screen brief. Preserve independent style/accent/mode settings and current product requirements. Design-review frame controls in the export are not product UI.

## Simon role and artifact handoff — confirmed scope

Simon facilitates productivity and hands heavy coding/research to specialist tools. Follow [the handoff/sharing specification](../../docs/notes/files/16_simon_handoffs_and_artifact_sharing.md). Prototype task → bounded context → editable specialist prompt → exact snapshot review → expiring link → signed-out artifact-only view → revoke. Add password and explicit public variants, mobile frames, and expired/failure states. Never imply a general-purpose coding/research agent or automatic external launch.
