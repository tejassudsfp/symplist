/**
 * The quick-access panel's decisions, as pure functions.
 *
 * Where the panel is drawn, how tall it is allowed to be, whether a message from it is well formed, and
 * whether hiding it should lock the vault — the Electron wiring in `vault-window.ts` and `tray.ts` reads
 * these and does what they say, so the rules have their own tests and no display attached.
 *
 * The one that matters is `shouldLockOnHide`. There is a single vault session behind this app, shared
 * with the main window, so locking on close is not free: a panel that locked unconditionally would
 * relock the vault someone had just unlocked in the workspace, every time they glanced at the menu bar.
 * It locks what it opened, which is what the panel's own footer promises — "Locks when this panel
 * closes" — and leaves a vault it found already open alone.
 */

/** The panel's fixed width, and the height bounds the renderer's measurement is clamped into. */
export const PANEL_WIDTH = 320;
export const PANEL_MIN_HEIGHT = 180;
export const PANEL_MAX_HEIGHT = 560;

/** The height a panel opens at, before the renderer has measured its content. */
export const PANEL_INITIAL_HEIGHT = 300;

/** How long a copied vault value may stay on the clipboard. */
export const CLIPBOARD_CLEAR_MS = 30_000;

/**
 * How long the local relock waits for the renderer's `POST /v1/vault/lock` to land.
 *
 * The request is the one that matters — it revokes the vault session at the api and publishes
 * `vault.locked`, so the main window's vault screen clears too — and it can only be sent by the page,
 * which holds the CSRF token. Dropping the cookie here first would make that request arrive
 * unauthenticated and achieve nothing. So the panel is told, and the cookie goes a moment later as the
 * half that cannot fail. If the request landed, the api already cleared the cookie and this is a no-op.
 */
export const RELOCK_GRACE_MS = 2_500;

/** What the panel last told the shell about itself. */
export interface VaultPanelState {
  /** The vault is open, so the menu-bar icon is drawn open and Lock Vault is enabled. */
  readonly unlocked: boolean;
  /** This panel is what unlocked it, so closing the panel should lock it again. */
  readonly unlockedHere: boolean;
  /** The signed-in address, for the tray menu. Null while signed out or still loading. */
  readonly email: string | null;
}

export const initialVaultPanelState: VaultPanelState = Object.freeze({
  unlocked: false,
  unlockedHere: false,
  email: null,
});

/** Parses a state report from the renderer. Anything malformed is discarded rather than guessed at. */
export function vaultPanelStateOf(value: unknown): VaultPanelState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.unlocked !== "boolean" || typeof record.unlockedHere !== "boolean") return null;
  // A missing address and a null one both mean "nobody to name in the tray menu".
  const email = record.email ?? null;
  if (email !== null && typeof email !== "string") return null;
  // A long string in the tray menu would be the renderer choosing the menu's width.
  if (typeof email === "string" && (email.length === 0 || email.length > 320)) return null;
  return { unlocked: record.unlocked, unlockedHere: record.unlockedHere, email: email ?? null };
}

/** Whether hiding the panel should lock the vault. See the module comment. */
export function shouldLockOnHide(state: VaultPanelState): boolean {
  return state.unlocked && state.unlockedHere;
}

/** The height the window is given for a measurement the renderer reported. */
export function clampPanelHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, value)));
}

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PanelPlacement {
  /** The menu-bar item the panel hangs from; Electron's `Tray.getBounds()`. */
  readonly anchor: Rectangle;
  /** The display's usable area; Electron's `Display.workArea`. */
  readonly work: Rectangle;
  readonly width: number;
  readonly height: number;
  /** The gap between the menu bar and the panel. */
  readonly gap?: number;
}

/**
 * Where the panel goes: centred under its menu-bar item, and pulled back inside the display if that
 * would hang it off an edge. An anchor of zero size — Linux and some Windows shells report one — means
 * the icon's position is unknown, so the panel goes to the top right corner instead of to x = 0.
 *
 * The horizontal margin is a margin, but the vertical minimum is the work area's own top edge: the work
 * area already starts below the menu bar, and a popover that hangs from a menu-bar item touches it.
 */
export function panelPosition(placement: PanelPlacement): {
  readonly x: number;
  readonly y: number;
} {
  const { anchor, work, width, height } = placement;
  const gap = placement.gap ?? 6;
  const margin = 8;
  const unanchored = anchor.width === 0 && anchor.height === 0;
  const centred = unanchored
    ? work.x + work.width - width - margin
    : Math.round(anchor.x + anchor.width / 2 - width / 2);
  const minX = work.x + margin;
  const maxX = Math.max(work.x + work.width - width - margin, minX);
  const below = unanchored ? work.y + gap : anchor.y + anchor.height + gap;
  const maxY = Math.max(work.y + work.height - height - margin, work.y);
  return {
    x: Math.round(Math.min(Math.max(centred, minX), maxX)),
    y: Math.round(Math.min(Math.max(below, work.y), maxY)),
  };
}

/** The renderer path the panel window loads. Kept here so the shell and its tests agree on one string. */
export const VAULT_PANEL_PATH = "/desktop/vault";

/**
 * The app paths the panel may ask the main window to open. An allowlist, because the renderer chooses
 * the value: without one, "open the app at this path" is "navigate the signed-in window anywhere".
 */
export const openableAppPaths: readonly string[] = Object.freeze(["/now", "/signin", "/vault"]);

/** The path the main window should load for a request from the panel, or null to refuse it. */
export function appPathFor(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  if (openableAppPaths.includes(value)) return value;
  // `Edit in Symplist ↗` names one item, and its id is the only variable part of that path. The
  // pattern is the api's canonical UUIDv7 (`packages/contracts/src/common/ids.ts`), not a looser one.
  const item =
    /^\/vault\/items\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  return item.test(value) ? value : null;
}
