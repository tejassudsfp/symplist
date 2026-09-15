# Keyboard-first interaction — build and design specification

Confirmed requirement: task navigation, document work, Simon chat, search, and settings must work comfortably from the keyboard. Documentation only; bindings below are proposed defaults to validate on supported browsers/operating systems before shipping.

## One action registry

Define every user-facing action once with a stable ID, label, context, permission predicate, handler, and optional binding. Buttons, menus, command palette, and shortcuts invoke the same action. A shortcut is never a second path around beta access, vault unlock, revision checks, or action approvals.

Every meaningful action should be searchable in the command palette. Frequently used actions get default shortcuts; destructive or rare actions may remain unbound. Do not assign a key to every operation merely to fill a reference sheet.

`Mod` means Command on macOS and Control on Windows/Linux. Display native key names. `g → c` means a sequence, not simultaneous keys. Show sequence progress briefly and reset after a short configurable timeout or Escape. All unmodified letters/sequences operate only in navigation contexts, never while typing.

## Proposed default bindings

| Action | Binding | Scope / behavior |
| --- | --- | --- |
| Open quick search / command palette | Mod+K | App; default mode finds tasks, `>` switches to actions |
| Search within current surface | / | Navigation only; focuses current list/page/chat search |
| Find within document | Mod+F | Only when document editor has focus and in-app find is available; otherwise retain browser find |
| Show shortcut reference | ? | Navigation only; searchable help also available in menu |
| Next / previous task | j / k or Down / Up | Inbox focus; moves active row without completing it |
| Open active task | Enter | Inbox focus; opens page and associated conversation |
| Next / previous open task | ] / [ | Workspace navigation focus; opens neighboring task in current visible order |
| Focus inbox | g → i | Navigation context |
| Open/focus task page | g → d | Selected task; preserve draft/scroll |
| Open/focus Simon chat | g → c | Selected task; expands chat and focuses composer |
| Now / Later / Unclassified | g → n / g → l / g → u | Open collection and focus its list |
| Archive | g → a | Open archive |
| Vault | g → v | Open vault destination; never bypass unlock |
| Settings | g → s | Open settings |
| Document history | g → h | Selected task page |
| New task | n | Navigation; inline creation in current collection |
| New subtask | Shift+N | Inbox with an active task |
| Rename task | r | Inbox with an active task; focus rename field |
| Move task | m | Inbox/task navigation; opens keyboard-selectable destination menu |
| Complete task | x | Inbox/task navigation; normal parent/running-agent rules apply |
| Expand / collapse sublist | Right / Left | Inbox tree; standard parent/child focus behavior |
| Open task action menu | Shift+F10 | Focused task row |
| Save current document | Mod+S | Editor focus; requests immediate save with truthful pending/saved status |
| Undo / redo typing | Mod+Z / platform redo | Editor/composer only; use native editor history |
| Send chat message | Mod+Enter | Composer; Enter inserts newline by default |
| Send via Enter | Optional preference | If enabled, Shift+Enter inserts newline; no send during IME composition |
| Dismiss current menu/dialog/find | Escape | Topmost dismissible surface; returns focus |

Actions exposed in the palette with no risky default chord: full search; stop Simon; toggle inbox/chat; restore archived task; restore document revision; lock vault; add vault item; appearance; service connections; agent connections; sign out. Approval, reveal secret, permanent deletion, and admin relock must remain deliberate actions with normal confirmation. Escape does not globally stop Simon or discard drafts.

Next/previous task order follows the displayed collection/filter/sort, not all tasks globally. Proposed boundary behavior is stop at the first/last item rather than wrap. Handle removed/completed items predictably. Switching tasks saves/retains per-task drafts, selection and scroll; Simon's running task stays associated with its original conversation.

## Focus and conflict rules

- Dispatch precedence: active modal/menu → editor/composer → focused pane → app navigation. Only the winning enabled action handles the event.
- Never interpret `n`, `/`, `?`, brackets, or sequences as navigation while typing in inputs, contenteditable, the Markdown editor, or an IME composition. This includes typing an email OTP or vault key.
- Preserve browser/OS shortcuts such as tab/window switching, address bar, reload, and browser history. If a proposed binding conflicts on a supported platform, leave it unbound or offer a safe alternative; document the final platform map.
- Do not intercept Tab outside a genuine modal. Editor tab behavior needs a clear way to leave it. Maintain visible focus and logical tab order across panels.
- Enter on a focused button activates that button, not a global send/complete action. Suppress repeated keydown for create/complete/send; allow controlled repeat for navigation.
- Disabled actions show a concise reason where useful and do not silently run through a shortcut. Screen-reader navigation and touch users retain equivalent controls.

## Discoverability and preferences

Show shortcuts beside menu/palette actions and in tooltips, with an accessible text equivalent. Add Settings → Keyboard shortcuts with search by action, grouped reference, a Disable single-key shortcuts toggle, and remapping/reset to defaults. Users can inspect conflicts before saving; duplicate bindings are allowed only for mutually exclusive contexts. Changing a binding updates every label through the same registry.

Treat remapping as account preference. Show local preview versus persisted state on save failure. Allow disabling app shortcuts and restoring defaults without being able to use shortcuts. Do not allow a remap to hijack reserved browser/OS controls. A configured alternative is needed for punctuation-based actions on incompatible keyboard layouts.

`?` and a menu entry open a compact shortcut help surface; they do not navigate away from a draft. The command palette is the primary fallback when someone does not remember a binding. User-facing UI should not expose action IDs or keyboard event codes.

## Acceptance criteria

Prototype and test a complete keyboard-only journey: switch collection → add task/subtask → open page → edit/save → focus chat → send → search another task → move/complete → archive/restore. Verify focus returns after every overlay and task changes preserve work.

Test input typing, IME, paste, held keys, nested dialogs, disabled/locked accounts, editor conflicts, screen-reader mode, alternate keyboard layouts, remapping conflicts, macOS/Windows/Linux labels, and narrow-screen hardware-keyboard use. A displayed binding must have an implemented, tested action; do not ship decorative shortcut labels.

## Calendar and reminder commands

Register Open calendar, Open notifications, Set deadline, Add reminder, Snooze notification, and Notification settings in the shared command palette and remapping UI. No new default global binding is required; preserve the existing collision-free map. Calendar date navigation uses focused-widget arrow keys; Enter selects, Escape closes/returns focus. Every drag-reschedule has a keyboard Change date alternative. Notification completion uses the existing task-completion handler and authorization.

## Handoff and sharing commands

Register Prepare handoff, Share artifact, Manage artifact links, Copy prepared prompt, and Revoke selected link in the command registry and remapping UI. No new default global key is required. Release/publish uses the same reviewed approval flow from keyboard, UI, and tools.
