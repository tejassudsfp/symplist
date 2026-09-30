/**
 * The application window. The renderer is the unchanged apps/web frontend, so it is treated as what it
 * is — a web page — and given no privileges: `sandbox: true`, `contextIsolation: true`,
 * `nodeIntegration: false`, no webview tag, no permissions. Everything it needs from the machine comes
 * through the preload bridge, one named channel at a time.
 */
import { BrowserWindow, nativeTheme, shell } from "electron";
import type { MainLog } from "./log.ts";
import { externalLinkDecision, isInternalUrl } from "./navigation.ts";

export interface CreateMainWindowOptions {
  readonly rendererOrigin: string;
  readonly preloadPath: string;
  readonly appVersion: string;
  /**
   * The cloud api origin. It reaches preload as a launch argument rather than over IPC because
   * `getApiClient()` in apps/web builds its client during a render and cannot await a round trip. Main
   * still pins every request to its own copy of this value, so the renderer holds a base URL, not a
   * permission.
   */
  readonly apiOrigin: string;
  readonly log: MainLog;
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const { log, rendererOrigin } = options;
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 520,
    // Shown on `ready-to-show`, so the first frame is the app and not an empty rectangle.
    show: false,
    // A placeholder only, to keep the flash before first paint the right end of the scale; the page's
    // own theme — six of them, light and dark — paints the real background.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#101012" : "#ffffff",
    // The system title bar stays: the frontend has no drag region of its own, and a hidden title bar
    // would leave the window unmovable on macOS.
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // Read in preload, where `app.getVersion()` does not exist and IPC has not been set up yet.
      additionalArguments: [
        `--symplist-app-version=${options.appVersion}`,
        `--symplist-api-origin=${options.apiOrigin}`,
      ],
    },
  });

  window.once("ready-to-show", () => window.show());

  // The window never leaves its own origin. A link in a document goes to the system browser instead,
  // because a remote page loaded here would share an origin with the preload bridge.
  window.webContents.on("will-navigate", (event, target) => {
    if (isInternalUrl(target, rendererOrigin)) return;
    event.preventDefault();
    if (externalLinkDecision(target) === "open-externally") {
      void shell.openExternal(target);
      log.info("navigation.externalized");
      return;
    }
    log.warn("navigation.refused");
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (externalLinkDecision(url) === "open-externally") {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    log.warn("window_open.refused");
    return { action: "deny" };
  });

  // Nothing in the frontend embeds a webview; if something ever does, it does not start here.
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    log.warn("webview.refused");
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    log.error("renderer.process_gone", { reason: details.reason, exitCode: details.exitCode });
  });

  return window;
}
