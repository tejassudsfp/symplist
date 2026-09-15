# Now — default workspace

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the primary daily view using the four-region layout in overall.md. Now is selected on the icon rail. The inbox has Now, quiet search, an inline Add task control, and a concise list. Preserve top-left profile and adjacent Vault. There is no summary dashboard above the work.

Populate with “Refresh my portfolio” (expanded, two subtasks), “Send the project outline” (agent needs input), and “Book a bike tune-up.” Selected task opens a real Markdown page in the center and its persistent chat on the right. Distinguish selection, completion, and agent status visually; a checkbox is not a selection control.

Required frames: first-use empty list with inline creation; populated list with task selected; no selection; both side panels visible; chat collapsed to a corner control; inbox collapsed; loading; list fetch error. Include a long title wrapping sensibly and a nested item selected. Avoid fake due dates or priority badges when not supplied.

Clicking another rail icon changes the inbox; selecting a task changes page and chat together. Row hover can reveal a drag handle and menu, but provide keyboard access without hover. Suggested task row anatomy: completion affordance, title, optional short preview, subtle active-agent marker only when relevant.

At 1024 px show a readable fallback with one panel collapsed. On mobile show collection selection plus list, then Page/Chat navigation. Prototype Add → select → open Chat. Theme comparisons must use this exact dataset.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Keyboard coverage

Follow the shared [keyboard map](../../docs/notes/files/13_keyboard_shortcuts.md). Show applicable menu hints, visible focus, next/previous task behavior, Page/Chat focus switching, and search entry. Navigation shortcuts must not activate while the user types. Include keyboard-only operation in the prototype and preserve drafts when focus/tasks change.

## Deadlines and notification integration

Follow [task scheduling](task_schedule.md), [calendar](calendar.md), and [notifications](notifications.md). Offer optional deadline/reminder actions through the task menu and command palette, show compact due labels where relevant, and retain list placement when dates change. Completion/archive suppresses pending reminders; restoring does not replay old alerts. Profile navigation exposes Calendar and Settings → Notifications. Avoid mandatory date fields or automatic urgency sorting.
