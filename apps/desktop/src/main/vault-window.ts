/**
 * The Vault quick-access window: a 320 px popover under the menu-bar icon, and nothing else from
 * Symplist.
 *
 * It is a second window on the renderer origin, not a second app. The page it loads is
 * `apps/web`'s `/desktop/vault`, so it inherits the person's theme — all six, light and dark — from
 * the same `sym_appearance` cookie the workspace reads, and it reaches `/v1/vault` through the same
 * `cloud` bridge, which means the session cookie stays in this process and the panel holds no token.
 * There is no vault code here: the routes it calls are the routes the web app already calls.
 *
 * What this module owns is the window's behaviour, which is a popover's rather than an app's. It hangs
 * off the tray item, it is hidden rather than closed so the next open is instant, it disappears on blur,
 * and hiding it locks the vault it opened — both by telling the renderer, which can send
 * `POST /v1/vault/lock`, and by dropping the vault cookie from the jar here, which does not depend on a
 * request completing. Quitting leaves the vault locked for free: the cookie lives in the jar's volatile
 * tier and is never written to disk (`cloud/cookie-jar.ts`).
 */

import { BrowserWindow, clipboard, nativeTheme, screen } from "electron";
import { ipcEvents } from "../shared/ipc.ts";
import type { MainLog } from "./log.ts";
import {
  CLIPBOARD_CLEAR_MS,
  clampPanelHeight,
  initialVaultPanelState,
  PANEL_INITIAL_HEIGHT,
  PANEL_WIDTH,
  panelPosition,
  RELOCK_GRACE_MS,
  type Rectangle,
  shouldLockOnHide,
  VAULT_PANEL_PATH,
  type VaultPanelState,
  vaultPanelStateOf,
} from "./vault-panel.ts";

export interface VaultWindowOptions {
  readonly rendererOrigin: string;
  readonly preloadPath: string;
  readonly appVersion: string;
  readonly apiOrigin: string;
  readonly log: MainLog;
  /** Where the tray item sits, or a zero rectangle when the platform does not say. */
  readonly anchor: () => Rectangle;
  /**
   * Drops the vault cookie from the cloud jar. The local half of locking: it holds even when the
   * renderer's `POST /v1/vault/lock` cannot be sent, and it is why closing the panel always locks.
   */
  readonly relockVault: () => void;
  /** Told whenever the panel's report changes, so the tray icon and menu follow it. */
  readonly onStateChange: (state: VaultPanelState) => void;
}

export interface VaultPanelWindow {
  /** Left-click on the tray item: show it, or hide it when it is already up. */
  toggle(): void;
  show(): void;
  hide(): void;
  /** Locks the vault and hides the panel. The tray menu's Lock Vault. */
  lock(): void;
  /** What the panel last reported. */
  state(): VaultPanelState;
  /** Whether a `webContents` id belongs to this window; the panel channels refuse every other sender. */
  ownsSender(webContentsId: number): boolean;
  /** `vaultPanel.report` from the renderer. */
  report(payload: unknown): void;
  /** `vaultPanel.resize` from the renderer. */
  resize(payload: unknown): void;
  /** `vaultPanel.copy` from the renderer: the clipboard, with its own timed clear. */
  copy(payload: unknown): Promise<boolean>;
  /**
   * The cloud session ended without anyone asking. The panel is told the same way the workspace is, so a
   * revoked session replaces its contents with the sign-in notice instead of waiting for a 401.
   */
  sessionEnded(): void;
  destroy(): void;
}

export function createVaultPanelWindow(options: VaultWindowOptions): VaultPanelWindow {
  const { log, rendererOrigin } = options;
  let window: BrowserWindow | null = null;
  let state: VaultPanelState = initialVaultPanelState;
  let height = PANEL_INITIAL_HEIGHT;
  let clearClipboard: ReturnType<typeof setTimeout> | null = null;
  let copiedValue: string | null = null;
  let pendingRelock: ReturnType<typeof setTimeout> | null = null;

  /**
   * Takes a copied vault value back off the clipboard, but only if the clipboard still holds it.
   * Clearing a clipboard someone has since filled with their own work would be this app deleting
   * something it was never given.
   */
  const forgetClipboard = async (): Promise<void> => {
    const value = copiedValue;
    copiedValue = null;
    if (value === null) return;
    try {
      if ((await clipboard.readText()) === value) clipboard.clear();
    } catch {
      // A clipboard that cannot be read cannot be checked, and is not cleared on a guess.
      log.warn("vault_panel.clipboard_unreadable");
    }
  };

  const setState = (next: VaultPanelState): void => {
    state = next;
    options.onStateChange(next);
  };

  const place = (): void => {
    if (!window) return;
    const anchor = options.anchor();
    const display = screen.getDisplayNearestPoint({
      x: anchor.x + Math.round(anchor.width / 2),
      y: anchor.y,
    });
    const position = panelPosition({
      anchor,
      work: display.workArea,
      width: PANEL_WIDTH,
      height,
    });
    window.setBounds({ ...position, width: PANEL_WIDTH, height });
  };

  const build = (): BrowserWindow => {
    const panel = new BrowserWindow({
      width: PANEL_WIDTH,
      height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // A placeholder only, so the flash before first paint is the right end of the scale; the page's
      // own theme — six of them, light and dark — paints the real surface.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#101012" : "#ffffff",
      transparent: false,
      roundedCorners: true,
      webPreferences: {
        preload: options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        additionalArguments: [
          `--symplist-app-version=${options.appVersion}`,
          `--symplist-api-origin=${options.apiOrigin}`,
        ],
      },
    });
    // Above a full-screen app and every ordinary window, which is what a menu-bar popover is.
    panel.setAlwaysOnTop(true, "floating");
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Clicking anywhere else closes the panel, and closing it locks. Not `close`: the window is kept so
    // the next open is instant and the renderer keeps its bridge.
    panel.on("blur", () => {
      if (panel.isVisible()) hide();
    });
    panel.webContents.on("render-process-gone", (_event, details) => {
      log.error("vault_panel.process_gone", { reason: details.reason });
      setState(initialVaultPanelState);
    });
    // The panel links out with `openApp`; it never navigates itself anywhere.
    panel.webContents.setWindowOpenHandler(() => {
      log.warn("vault_panel.window_open_refused");
      return { action: "deny" };
    });
    panel.webContents.on("will-navigate", (event, target) => {
      if (target.startsWith(`${rendererOrigin}${VAULT_PANEL_PATH}`)) return;
      event.preventDefault();
      log.warn("vault_panel.navigation_refused");
    });
    return panel;
  };

  /**
   * Hides the panel and, when the vault should lock, locks it twice over.
   *
   * The renderer is asked first, because only it can send `POST /v1/vault/lock` — the request that
   * actually revokes the vault session at the api and publishes `vault.locked`, which is what makes the
   * main window's open vault screen clear itself. Then the vault cookie is dropped from this process's
   * jar a moment later, which needs no network and no live window. If the request landed the api already
   * cleared the cookie and the backstop is a no-op; if it did not, the vault is still locked here, which
   * is the half that must not be able to fail.
   */
  const dismiss = (lockIt: boolean): void => {
    const panel = window;
    if (!panel || panel.isDestroyed()) return;
    if (panel.isVisible()) panel.hide();
    setState({ ...initialVaultPanelState, email: state.email });
    panel.webContents.send(ipcEvents.vaultPanelDismissed);
    if (pendingRelock) clearTimeout(pendingRelock);
    pendingRelock = null;
    if (lockIt) {
      pendingRelock = setTimeout(() => {
        pendingRelock = null;
        options.relockVault();
      }, RELOCK_GRACE_MS);
    }
    log.info("vault_panel.hidden", { locked: lockIt });
  };

  const hide = (): void => dismiss(shouldLockOnHide(state));

  const show = (): void => {
    // A reopen inside the grace window is the same vault, not a stale one to drop under the person.
    if (pendingRelock) clearTimeout(pendingRelock);
    pendingRelock = null;
    window ??= build();
    const panel = window;
    place();
    if (panel.webContents.getURL().length === 0) {
      void panel.loadURL(`${rendererOrigin}${VAULT_PANEL_PATH}`).catch((error: unknown) => {
        log.error("vault_panel.load_failed", { message: String(error) });
      });
    } else {
      panel.webContents.send(ipcEvents.vaultPanelShown);
    }
    panel.show();
    panel.focus();
  };

  return {
    toggle: () => {
      if (window && !window.isDestroyed() && window.isVisible()) hide();
      else show();
    },
    show,
    hide,
    lock: () => {
      // Forces the lock whether the panel opened the vault or the workspace did: the tray menu item
      // says Lock Vault, and someone reaching for it means both.
      if (window && !window.isDestroyed()) dismiss(true);
      else options.relockVault();
      log.info("vault_panel.locked");
    },
    state: () => state,
    ownsSender: (webContentsId) =>
      window !== null && !window.isDestroyed() && window.webContents.id === webContentsId,
    report: (payload) => {
      const next = vaultPanelStateOf(payload);
      if (!next) {
        log.warn("vault_panel.report_malformed");
        return;
      }
      setState(next);
    },
    resize: (payload) => {
      const next = clampPanelHeight(payload);
      if (next === null || next === height) return;
      height = next;
      place();
    },
    copy: async (payload) => {
      if (typeof payload !== "string" || payload.length === 0) return false;
      try {
        await clipboard.writeText(payload);
      } catch {
        log.warn("vault_panel.copy_failed");
        return false;
      }
      copiedValue = payload;
      if (clearClipboard) clearTimeout(clearClipboard);
      clearClipboard = setTimeout(() => {
        clearClipboard = null;
        void forgetClipboard();
      }, CLIPBOARD_CLEAR_MS);
      // The value is never logged, and neither is its length: a length is a fact about a secret.
      log.info("vault_panel.copied");
      return true;
    },
    sessionEnded: () => {
      const panel = window;
      if (!panel || panel.isDestroyed()) return;
      // No session means no vault, so the panel is dismissed and its contents forgotten as well.
      dismiss(false);
      panel.webContents.send(ipcEvents.cloudSessionEnded);
    },
    destroy: () => {
      if (pendingRelock) clearTimeout(pendingRelock);
      pendingRelock = null;
      if (clearClipboard) clearTimeout(clearClipboard);
      clearClipboard = null;
      void forgetClipboard();
      const panel = window;
      window = null;
      if (panel && !panel.isDestroyed()) panel.destroy();
    },
  };
}
