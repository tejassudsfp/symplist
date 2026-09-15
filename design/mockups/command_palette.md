# Quick switcher and command palette

Read [overall.md](overall.md), [themes.md](themes.md), and the [keyboard specification](../../docs/notes/files/13_keyboard_shortcuts.md).

Design Mod+K as a fast overlay that opens without navigating away from current work. Default mode switches tasks by title; an explicit Actions option or `>` prefix searches commands. Keep the modes visually distinct. Empty query shows a small recent-task list, never vault values or secret query history.

Task results show title, collection, and an optional parent breadcrumb. Action results show action label, context, and the user's current shortcut. Disabled actions either disappear or explain why they are unavailable. Commands include new task, move, focus page/chat, stop Simon, toggle panels, appearance, history, vault, and archive. No beta billing actions.

Show exact/prefix/typo task results, action mode, empty query, no matches, disabled action, loading/error, and “Search all content” transferring the query to full search. Results support arrow selection, Enter, Escape, and focus return. Opening a task switches page and chat together and preserves prior drafts.

Commands use normal dialogs/approvals; selecting Restore, vault access, or a destructive action never bypasses its safeguards. Locked users must not retrieve protected task results through the palette.

Desktop centered overlay, laptop constrained overlay, and mobile full-height surface are required. Keep shortcut typography and focus indicators legible in all themes. Prototype a keyboard-only sequence: open → find task → open → reopen → choose Focus Simon chat. Include a compact visible distinction between task search and action search; avoid an elaborate multi-mode dashboard.

## Deadlines and notification integration

Follow [task scheduling](task_schedule.md), [calendar](calendar.md), and [notifications](notifications.md). Offer optional deadline/reminder actions through the task menu and command palette, show compact due labels where relevant, and retain list placement when dates change. Completion/archive suppresses pending reminders; restoring does not replay old alerts. Profile navigation exposes Calendar and Settings → Notifications. Avoid mandatory date fields or automatic urgency sorting.

## Specialist handoff and artifact actions

Follow [Handoff](handoff.md), [Share artifact](artifact_share.md), and [Manage links](artifact_shares.md). Simon can prepare full specialist instructions from bounded task context; it does not perform heavy coding/deep research itself. Show editable prompt and reviewed release as separate steps. No link is published or sent merely because a suggestion appears. Existing task chat remains the same conversation.
