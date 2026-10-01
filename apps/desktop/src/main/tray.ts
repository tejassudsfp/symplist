/**
 * The menu-bar item: the Symplist mark, opening the Vault quick-access panel under it.
 *
 * Left-click toggles the panel, right-click opens the native menu, and ⇧⌘V does the same from whatever
 * app is in front — the panel does not need the main window, or the Dock, or anything else from
 * Symplist to be open. The icon is drawn open while the vault is unlocked, so its state is readable
 * without opening anything.
 *
 * The icon is a template image on macOS: two black-and-alpha bitmaps drawn in `tray-icon.ts` at 1× and
 * 2×, which the system recolours for a light or dark menu bar and for the highlight. That is why there
 * is no colour and no second asset anywhere in this file.
 *
 * ⌘L is in the menu because the panel honours it, not because it is registered globally. Taking ⌘L away
 * from every other application on the machine to lock a vault would be a poor trade, so the accelerator
 * is shown — macOS does not fire a tray menu's accelerators — and the panel's own key handler does the
 * work. ⇧⌘V is registered, because "from anywhere" is the point of it.
 *
 * The menu is popped up by hand on macOS rather than attached with `setContextMenu`, because an attached
 * menu claims the left click as well and the left click is the panel's.
 */

import { app, globalShortcut, Menu, nativeImage, Tray } from "electron";
import type { MainLog } from "./log.ts";
import { markDataUrl } from "./tray-icon.ts";
import type { Rectangle } from "./vault-panel.ts";
import type { VaultPanelWindow } from "./vault-window.ts";

/** The menu-bar item's logical size. 16 points is the macOS convention; 2× is the retina bitmap. */
const ICON_POINTS = 16;

/** The accelerator that opens the panel from anywhere. */
export const OPEN_PANEL_ACCELERATOR = "Shift+CommandOrControl+V";

/** The accelerator the panel handles itself, shown in the menu so it can be discovered. */
export const LOCK_ACCELERATOR = "CommandOrControl+L";

export interface VaultTrayOptions {
  readonly log: MainLog;
  readonly panel: VaultPanelWindow;
  /** Raises the main workspace window at a path. */
  readonly openApp: (path: string) => void;
}

export interface VaultTray {
  /** Redraws the icon and rebuilds the menu after the panel reports a new state. */
  refresh(): void;
  /** Where the item sits, for placing the panel under it. A zero rectangle when the platform is silent. */
  bounds(): Rectangle;
  destroy(): void;
}

/*
 * One image, drawn once. The icon is the Symplist mark and does not change with the vault's state —
 * the tooltip still says which it is, and the panel says it plainly.
 */
function markImage(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(markDataUrl({ size: ICON_POINTS }));
  image.addRepresentation({
    scaleFactor: 2,
    dataURL: markDataUrl({ size: ICON_POINTS * 2 }),
  });
  // macOS then owns the colour: light bar, dark bar, and the inverted highlight while the menu is open.
  image.setTemplateImage(true);
  return image;
}

export function createVaultTray(options: VaultTrayOptions): VaultTray {
  const { log, panel } = options;
  const tray = new Tray(markImage());
  tray.setToolTip("Symplist Vault");
  tray.setIgnoreDoubleClickEvents(true);
  let menu = Menu.buildFromTemplate([]);

  const refresh = (): void => {
    const state = panel.state();
    tray.setToolTip(state.unlocked ? "Symplist Vault — unlocked" : "Symplist Vault");
    menu = Menu.buildFromTemplate([
      {
        label: "Open Vault",
        accelerator: OPEN_PANEL_ACCELERATOR,
        click: () => panel.show(),
      },
      {
        label: "Lock Vault",
        accelerator: LOCK_ACCELERATOR,
        enabled: state.unlocked,
        // Registering this accelerator globally would take ⌘L from every other app on the machine.
        registerAccelerator: false,
        click: () => panel.lock(),
      },
      { type: "separator" },
      { label: "Open Symplist", click: () => options.openApp("/now") },
      { type: "separator" },
      {
        label: state.email === null ? "Not signed in" : `Signed in as ${state.email}`,
        enabled: false,
      },
      { label: "Quit Symplist", accelerator: "CommandOrControl+Q", role: "quit" },
    ]);
    // Linux emits no tray click events at all, so there the attached menu is the only way in and it has
    // to be attached. On macOS an attached menu claims the **left** click too, which would leave the
    // the item opening a menu instead of the panel — so there the menu is popped up by hand instead.
    if (process.platform !== "darwin") tray.setContextMenu(menu);
  };

  refresh();

  tray.on("click", () => panel.toggle());
  tray.on("right-click", () => tray.popUpContextMenu(menu));

  if (globalShortcut.register(OPEN_PANEL_ACCELERATOR, () => panel.toggle())) {
    log.info("tray.shortcut_registered");
  } else {
    // Another application already holds it. The menu-bar icon still works, which is the main path.
    log.warn("tray.shortcut_unavailable", { accelerator: OPEN_PANEL_ACCELERATOR });
  }

  app.on("will-quit", () => globalShortcut.unregister(OPEN_PANEL_ACCELERATOR));

  return {
    refresh,
    bounds: () => {
      const rectangle = tray.getBounds();
      return {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
      };
    },
    destroy: () => {
      globalShortcut.unregister(OPEN_PANEL_ACCELERATOR);
      tray.destroy();
    },
  };
}
