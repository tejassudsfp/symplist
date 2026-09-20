"use client";

import { usePathname } from "next/navigation";
import { usePostNavigationFocus } from "./navigation.ts";
import { PaletteDialog } from "./palette.tsx";
import { ShortcutHelpDialog } from "./shortcut-help.tsx";
import { useSearchOverlay } from "./store.ts";

/**
 * The search feature's overlays, mounted once inside the shell's action registry (§10.1, §10.2):
 * the quick switcher and command palette (Mod+K, command_palette.md) and the shortcut help overlay
 * (`?` or the profile menu, keyboard_shortcuts.md). Neither navigates away from the current work, and
 * each opening starts fresh, so nothing of a previous search stays on screen or in memory.
 */
export function CommandPalette() {
  const overlay = useSearchOverlay();
  usePostNavigationFocus(usePathname());
  if (overlay.kind === "palette") {
    return <PaletteDialog key={overlay.openCount} overlay={overlay} />;
  }
  if (overlay.kind === "help") {
    return <ShortcutHelpDialog key={overlay.openCount} overlay={overlay} />;
  }
  return null;
}
