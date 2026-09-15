# Task page — Markdown workspace

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the center pane for “Refresh my portfolio.” Header: title, current collection, completion control, restrained overflow menu, and access to document history. Below is the editable Markdown document with headings Overview, Projects to feature, Next steps, and Links. Use realistic short content and checklists, not lorem ipsum.

The editor should feel like a page. Provide a small contextual formatting toolbar or quiet editing controls and a discoverable raw Markdown view; switching views preserves content and position. No sprawling ribbon or mandatory database properties. Show rendered headings, a list, link, blockquote, table, fenced code, and an empty document inviting the user to write or ask the agent.

States: empty page; editing; saving; saved; save failed with draft retained; agent updates a named section; concurrent edit conflict. Distinguish saved from merely typed. A compact “Updated Next steps” event can link to the change without flashing the whole page. The agent reads and edits sections and should not duplicate the complete page in chat.

When conflict occurs, show concise context and actions to review changes/keep draft; never imply the latest local writing was overwritten. Reuse document_history.md for detailed review. Include collapsed chat and narrow/mobile page layout, with a clear Chat switch carrying task identity.

Prototype manual edit → saved; ask agent to update a section → visible change; and conflict → review. The visual theme affects document typography and framing without reducing editability.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Keyboard coverage

Follow the shared [keyboard map](../../docs/notes/files/13_keyboard_shortcuts.md). Show applicable menu hints, visible focus, next/previous task behavior, Page/Chat focus switching, and search entry. Navigation shortcuts must not activate while the user types. Include keyboard-only operation in the prototype and preserve drafts when focus/tasks change.

## Deadlines and notification integration

Follow [task scheduling](task_schedule.md), [calendar](calendar.md), and [notifications](notifications.md). Offer optional deadline/reminder actions through the task menu and command palette, show compact due labels where relevant, and retain list placement when dates change. Completion/archive suppresses pending reminders; restoring does not replay old alerts. Profile navigation exposes Calendar and Settings → Notifications. Avoid mandatory date fields or automatic urgency sorting.

## Specialist handoff and artifact actions

Follow [Handoff](handoff.md), [Share artifact](artifact_share.md), and [Manage links](artifact_shares.md). Simon can prepare full specialist instructions from bounded task context; it does not perform heavy coding/deep research itself. Show editable prompt and reviewed release as separate steps. No link is published or sent merely because a suggestion appears. Existing task chat remains the same conversation.
