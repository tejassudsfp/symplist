# Task creation, nesting, movement, and completion

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the interaction states shared by all three inboxes. This brief covers inline controls and small dialogs rather than a new standalone navigation destination.

Creation: one title field and Enter to add; no mandatory modal with description, dates, priorities, labels, or estimates. Escape cancels an empty creation draft; preserve meaningful input when focus moves. Show adding under a parent via Add subtask and an expandable sublist. Use up to three visible depths in the mockup with a sensible long-name fallback.

Task menu: Rename, Add subtask, Move to Now/Later/Unclassified, Complete. Avoid inventing hard deletion semantics; any permanent-delete control should be omitted from this first design or clearly marked as a proposal requiring product approval. Dragging provides an insertion cue and a rail destination cue, with an Undo affordance after success.

Parent movement carries its descendants. Parent completion when subtasks remain incomplete is an unresolved product choice: show a proposed confirmation listing the affected count and clearly annotate the chosen behavior; do not silently mark them done. Demonstrate completion of a leaf task → archive plus Undo.

If a task has an active agent run, show a proposed completion confirmation offering to stop work before archiving; note that completed external actions cannot be undone. Include rename/save failure, move rejection, duplicate submit prevention, and keyboard-only equivalents. Draw focus states and touch menus as first-class interactions.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Keyboard coverage

Follow the shared [keyboard map](../../docs/notes/files/13_keyboard_shortcuts.md). Show applicable menu hints, visible focus, next/previous task behavior, Page/Chat focus switching, and search entry. Navigation shortcuts must not activate while the user types. Include keyboard-only operation in the prototype and preserve drafts when focus/tasks change.

## Deadlines and notification integration

Follow [task scheduling](task_schedule.md), [calendar](calendar.md), and [notifications](notifications.md). Offer optional deadline/reminder actions through the task menu and command palette, show compact due labels where relevant, and retain list placement when dates change. Completion/archive suppresses pending reminders; restoring does not replay old alerts. Profile navigation exposes Calendar and Settings → Notifications. Avoid mandatory date fields or automatic urgency sorting.

## Specialist handoff and artifact actions

Follow [Handoff](handoff.md), [Share artifact](artifact_share.md), and [Manage links](artifact_shares.md). Simon can prepare full specialist instructions from bounded task context; it does not perform heavy coding/deep research itself. Show editable prompt and reviewed release as separate steps. No link is published or sent merely because a suggestion appears. Existing task chat remains the same conversation.
