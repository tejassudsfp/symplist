# Archived tasks and restoration

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design Archive as a separate page reachable from the profile menu. Show search, a simple completion-date grouping, and archived task rows retaining parent/subtask hierarchy where appropriate. Sample completed tasks: “Book the pottery class,” “Send the project outline,” and “Choose portfolio photos.”

Selecting an item opens its retained page and conversation in an archived/read-only state, with a prominent but calm Restore action. Avoid allowing a new agent run on an archived item without restoring it. Show original collection metadata where helpful; proposed restore behavior is original collection, falling back to Now when unavailable. Annotate this assumption.

Required states: empty archive, populated archive, selected record with page/chat history, search with no matches, restore in progress, restored, and restore failed. Show a way back to the active workspace. Completion is archival rather than destructive deletion; do not call the archive Trash.

For a parent group, communicate what restoring the group affects. Avoid multiple repeated confirmation dialogs for ordinary reversible restore. Include one compact undo/result message and a keyboard-accessible row menu.

No completion streak charts, productivity scores, or guilt metrics. Mobile uses list → detail. Theme signatures should remain subtle, with readable completion dates and muted but sufficient text contrast.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Keyboard coverage

Follow the shared [keyboard map](../../docs/notes/files/13_keyboard_shortcuts.md). Show applicable menu hints, visible focus, next/previous task behavior, Page/Chat focus switching, and search entry. Navigation shortcuts must not activate while the user types. Include keyboard-only operation in the prototype and preserve drafts when focus/tasks change.

## Deadlines and notification integration

Follow [task scheduling](task_schedule.md), [calendar](calendar.md), and [notifications](notifications.md). Offer optional deadline/reminder actions through the task menu and command palette, show compact due labels where relevant, and retain list placement when dates change. Completion/archive suppresses pending reminders; restoring does not replay old alerts. Profile navigation exposes Calendar and Settings → Notifications. Avoid mandatory date fields or automatic urgency sorting.
