import { SHORTCUT_HELP_ACTION_ID } from "@/actions/shell-actions";
import type { ActionAvailability, ActionEnvironment, AppAction } from "@/actions/types";
import { SEARCH_PATH } from "./routes.ts";
import { searchOverlay } from "./store.ts";
import { focusSurfaceFind, surfaceFindTarget } from "./surface-find.ts";

/*
 * The search feature's actions (§10.2, note 13): the quick switcher and command palette (Mod+K),
 * find within the current surface (/), the shortcut reference (?) and full search, which stays
 * unbound because it is a navigation, not a risky chord. Buttons, menus and the palette run these
 * same actions through the registry.
 */

/** Mod+K: the quick switcher and command palette. */
export const OPEN_PALETTE_ACTION_ID = "search.open_palette";
/** `?`: the shortcut help overlay, also opened from the profile menu (keyboard_shortcuts.md). */
export { SHORTCUT_HELP_ACTION_ID };
/** Opens the full search screen with whatever the palette had typed. */
export const FULL_SEARCH_ACTION_ID = "search.full_search";
/** `/`: focuses the find field of the surface that has focus. */
export const SURFACE_FIND_ACTION_ID = "search.find_here";

const enabled: ActionAvailability = { enabled: true };

export const searchActions: readonly AppAction[] = [
  {
    id: OPEN_PALETTE_ACTION_ID,
    label: "Search tasks and actions",
    context: "app",
    group: "search",
    keywords: ["command palette", "quick switcher", "go to task", "jump"],
    defaultBinding: "mod+k",
    availability: () => enabled,
    run: () => searchOverlay.openPalette(),
  },
  {
    id: FULL_SEARCH_ACTION_ID,
    label: "Search all content",
    context: "app",
    group: "search",
    keywords: ["full search", "documents", "chat", "find"],
    availability: () => enabled,
    run: ({ services }) => services.navigate(SEARCH_PATH),
  },
  {
    id: SURFACE_FIND_ACTION_ID,
    label: "Search in this view",
    context: "app",
    group: "search",
    keywords: ["find", "filter list", "find in page"],
    defaultBinding: "/",
    availability: (environment: ActionEnvironment) =>
      surfaceFindTarget(environment.pane)
        ? enabled
        : { enabled: false, reason: "This view has nothing to search" },
    run: ({ pane }) => {
      focusSurfaceFind(pane);
    },
  },
  {
    id: SHORTCUT_HELP_ACTION_ID,
    // "Shortcut help" names the overlay, so it never reads as the Settings → Keyboard shortcuts
    // page that remaps them; both are reachable from the profile menu (keyboard_shortcuts.md).
    label: "Shortcut help",
    context: "app",
    group: "general",
    keywords: ["help", "shortcut reference", "keys", "bindings", "keyboard shortcuts"],
    defaultBinding: "?",
    availability: () => enabled,
    run: () => searchOverlay.openHelp(),
  },
];
