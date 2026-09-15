# Shortcut help and keyboard settings

Read [overall.md](overall.md) and the [authoritative proposed key map](../../docs/notes/files/13_keyboard_shortcuts.md). Do not invent conflicting shortcuts independently in other screens.

Design two related surfaces: a dismissible shortcut-help overlay opened by `?` or the menu, and Settings → Keyboard shortcuts for preferences/remapping. Neither surface discards a task draft or stops Simon.

Group by Navigation, Tasks, Page, Chat, Search, and General. Search by action name or current binding. Use platform-aware keycaps: Command on macOS, Control on Windows/Linux. Clearly distinguish sequences (`g`, then `c`) from simultaneous chords. Show contextual notes such as “While the task list is focused” and “Unavailable while typing.”

Settings includes Disable single-key shortcuts, remap/unbind an action, conflict detection, and Restore defaults. Show recording a binding, supported assignment, reserved shortcut rejected, overlapping-context conflict, successful save, failed save with local preview distinguished, and reset confirmation. Do not expose raw keyboard event codes.

Include Page/Chat focus, next/previous task, new/subtask, move, complete, find, command palette, and send-message behavior. Composer Enter inserts a newline by default; Mod+Enter sends. If users enable Enter-to-send, show the Shift+Enter hint. Stop Simon remains an explicit palette/button action unless assigned a safe binding.

Prototype opening help, finding Next task, closing with focus restored, remapping one action, and seeing the updated label in its menu. Include desktop/mobile and visible focus in all themes. Users must be able to disable or reset shortcuts through pointer/touch controls as well as keyboard.
