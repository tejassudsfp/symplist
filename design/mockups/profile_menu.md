# Profile menu and navigation

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the top-left profile control and its dropdown, with the Vault button immediately beside it in the top bar. Keep this location consistent across the desktop app. The menu displays Maya Rao and maya@example.com, then Settings, Connections, Archive, Keyboard shortcuts, About, and Sign out. Beta administration appears only for administrator accounts.

Show default, hover/focus, open, long-name/email truncation, administrator variant, and sign-out progress/error. Do not add Billing, Upgrade, referral codes, or quota usage. A subtle active-theme indication is optional, but Appearance settings owns the full theme controls.

Profile menus in locked-account screens must be reduced to permitted identity/account actions; do not expose usable protected navigation. The vault should not reveal item names in its button or tooltip while locked.

Provide keyboard opening, arrow navigation, escape, click-outside, and focus-return annotations. On mobile use a compact top bar and a reachable menu surface; preserve Vault access without adding a second permanent navigation system.

Sign out clears protected content and returns to email entry. If a document has unsaved changes, design an explicit save/discard decision before leaving; avoid silently promising that all changes were saved. Theme switching belongs in settings and is not a hidden dropdown-only feature.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Deadlines and notification integration

Follow [task scheduling](task_schedule.md), [calendar](calendar.md), and [notifications](notifications.md). Offer optional deadline/reminder actions through the task menu and command palette, show compact due labels where relevant, and retain list placement when dates change. Completion/archive suppresses pending reminders; restoring does not replay old alerts. Profile navigation exposes Calendar and Settings → Notifications. Avoid mandatory date fields or automatic urgency sorting.
