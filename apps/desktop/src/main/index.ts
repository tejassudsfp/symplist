/**
 * Symplist desktop: application lifecycle.
 *
 * Two processes live in this app. **main** (this file) owns everything privileged: the renderer's Next
 * server, the cloud session and the keychain it is stored in, and the menu-bar item with the Vault
 * quick-access popover under it. **renderer** is the unchanged apps/web frontend with no privileges and
 * no network reach of its own — in two windows now, the workspace and that popover, both on the same
 * local origin and both dataless for the same reason.
 *
 * There used to be a third. `dsh` ran here as a child driven over ACP, because Simon lived inside this
 * app. Note 18 replaced that: Symplist publishes its tools over the api's `/mcp` endpoint and the
 * assistant is whichever MCP client the person already uses — which is strictly more capable, since
 * that client has their real shell in their real repository rather than a sandbox we chose. What this
 * app is now is the list, on the desktop.
 *
 * Cloud traffic belongs in main, and that is not a preference. The api pins its first-party origin:
 * `route-classes.ts` requires `Origin === WEB_ORIGIN` for sign-in on every method, CORS allows exactly
 * one origin, the session cookie is `__Host-` with `SameSite=Lax`, and the WebSocket upgrade refuses a
 * foreign `Origin` before it looks at the session. A page served from 127.0.0.1 is cross-site to all of
 * that and cannot sign in. Plain Node is subject to none of it. So main holds the jar and sets the
 * header, the api changes not at all, and the renderer stays dataless — which is also what makes a
 * loopback HTTP listener acceptable in the first place.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, safeStorage, session } from "electron";
import { ipcEvents } from "../shared/ipc.ts";
import { CookieJar } from "./cloud/cookie-jar.ts";
import { createCloudHttp } from "./cloud/http.ts";
import { type CloudHandlers, createCloudHandlers } from "./cloud/ipc.ts";
import { clearSessionHint, setSessionHint } from "./cloud/session-hint.ts";
import { CloudSession } from "./cloud/session-state.ts";
import { type CloudConfig, resolveCloudConfig } from "./config.ts";
import { registerIpcHandlers } from "./ipc.ts";
import { createMainLog } from "./log.ts";
import { type RendererServer, startRendererServer } from "./next-server.ts";
import { SecretStore } from "./secrets/secret-store.ts";
import { captureWindow, smokeCapturePath } from "./smoke.ts";
import { createVaultTray, type VaultTray } from "./tray.ts";
import { createVaultPanelWindow, type VaultPanelWindow } from "./vault-window.ts";
import { createMainWindow } from "./window.ts";

/** The shell opens the list, never the public homepage that ships in the same server. */
const WORKSPACE_PATH = "/now";

/**
 * The one environment variable that separates development from a packaged app: set it to the `next dev`
 * origin and the app loads that instead of booting the staged standalone build. Everything else —
 * window options, the bridge, the sender checks — is identical in both.
 */
const DEV_SERVER_ENV = "SYMPLIST_DESKTOP_DEV_SERVER_URL";

const log = createMainLog();
let rendererServer: RendererServer | null = null;
let mainWindow: BrowserWindow | null = null;
let cloudHandlers: CloudHandlers | null = null;
let vaultPanel: VaultPanelWindow | null = null;
let vaultTray: VaultTray | null = null;
/** Resolved by `whenReady`; the secret store refuses to answer before that, and would answer wrongly. */
let electronReady = false;

/**
 * Two copies of the app would mean two cloud sessions and two assistants against one workspace, so the
 * second launch focuses the first instead.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// The product name, not the package name: `@symplist/desktop` would put a slash in the userData path.
//
// This call alone did not do it. Electron resolves the app name — and therefore userData — before
// this module's top level runs in a packaged app, so userData landed in
// `Application Support/@symplist/desktop`, the exact shape this line was written to avoid.
// `productName` in package.json is what Electron actually reads, and it is set there now. This stays
// for the development run and as the statement of intent.
app.setName("Symplist");

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  // macOS keeps the app in the Dock with no window; every other platform quits. The Vault panel is not
  // a window in this sense — it is hidden, not closed — so it never keeps the app alive on its own.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  const server = rendererServer;
  rendererServer = null;
  if (server) void server.stop();
  // A request still in flight would resolve into a window that no longer exists.
  cloudHandlers?.abortAll();
  // Takes a copied vault value back off the clipboard and drops the menu-bar item.
  vaultPanel?.destroy();
  vaultTray?.destroy();
});

/** The staged web build: under `Resources` when packaged, under `build/` when run from the workspace. */
function stagedWebRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(import.meta.dirname, "..", "build", "web");
}

function hardenSession(): void {
  const defaultSession = session.defaultSession;
  // The frontend asks for no device permissions. Notifications and clipboard reads may be wanted later;
  // they get added here, by name, when a feature needs one.
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    log.warn("permission.refused", { permission });
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
}

/**
 * The cloud transport: the cookie jar, the keychain-backed store, the outbound client that sets the
 * `Origin` header, the session's own lifetime, and the MCP grant whose lifetime follows it.
 *
 * Built here and not at module scope because `safeStorage.isEncryptionAvailable()` answers `false` before
 * `app.whenReady()` — measured, not assumed — so a store constructed and consulted earlier would
 * conclude this machine cannot encrypt and silently stop persisting the session.
 */
async function startCloud(
  config: CloudConfig,
  rendererWindow: () => BrowserWindow | null,
  rendererOrigin: string,
): Promise<{
  readonly handlers: CloudHandlers;
  /** Where the session is persisted, and where an offline mode will keep its content key. */
  readonly store: SecretStore;
  /**
   * Drops the vault cookie without touching the sign-in session: the local half of locking the vault,
   * used when the quick-access panel closes. It is the jar's `clearVolatile` tier and nothing else, so
   * it cannot sign anyone out, and it needs no network — which is the point of having it.
   */
  readonly relockVault: () => void;
}> {
  const jar = new CookieJar();
  const store = new SecretStore({
    userDataPath: app.getPath("userData"),
    safeStorage,
    log,
    fs: { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync },
    isReady: () => electronReady,
  });
  const http = createCloudHttp({
    apiOrigin: config.apiOrigin,
    webOrigin: config.webOrigin,
    jar,
    log,
  });
  const hintTarget = { session: session.defaultSession, origin: rendererOrigin };
  const cloudSession = new CloudSession({
    apiOrigin: config.apiOrigin,
    jar,
    store,
    http,
    log,
    onSessionEnded: () => {
      // The web app turns this into `markSignedOut({ expired: true })`, which routes to sign-in with the
      // notice it already has for a session that ended on its own. Both windows are told: without this
      // the Vault panel would keep showing a list until its next request answered 401.
      rendererWindow()?.webContents.send(ipcEvents.cloudSessionEnded);
      vaultPanel?.sessionEnded();
      void clearSessionHint(hintTarget).catch((error: unknown) => {
        log.warn("cloud.hint_clear_failed", { message: String(error) });
      });
    },
    onSessionStarted: () => {
      // Without this the proxy sends a signed-in user to `/signin`, which asks `GET /v1/me`, learns
      // they are signed in, and navigates back — forever. See `session-hint.ts`.
      void setSessionHint(hintTarget).catch((error: unknown) => {
        log.warn("cloud.hint_set_failed", { message: String(error) });
      });
    },
  });
  if (!store.isAvailable()) {
    // No keychain means no persistence at all, and never a plaintext file. Users experience this as
    // signing in on every launch, so it is logged plainly rather than left to be guessed at.
    log.warn("cloud.persistence_unavailable");
  }
  const outcome = await cloudSession.restore();
  log.info("cloud.restore", { outcome, apiOrigin: config.apiOrigin });
  // `restore` adopts a session without transitioning through signed-out, so the start signal does not
  // fire for it. The renderer still needs the hint, or the first navigation loops.
  if (cloudSession.currentIdentity() !== null) await setSessionHint(hintTarget);
  else await clearSessionHint(hintTarget);

  /*
   * No MCP relay, and no device grant to mint for one.
   *
   * This app used to start a loopback relay and hold a `sym_` grant so the harness child could reach
   * Symplist's tools. With the agent gone (note 18) the person's own MCP client connects to
   * `<api>/mcp` directly over OAuth, which is a better arrangement than proxying: the grant is theirs,
   * the consent screen is the api's, and no bearer token ever passes through this process.
   */
  return {
    handlers: createCloudHandlers({
      apiOrigin: config.apiOrigin,
      http,
      session: cloudSession,
      log,
    }),
    store,
    relockVault: () => jar.clearVolatile(),
  };
}

async function start(): Promise<void> {
  electronReady = true;
  hardenSession();

  const devServerUrl = process.env[DEV_SERVER_ENV];
  let rendererOrigin: string;
  if (devServerUrl) {
    rendererOrigin = new URL(devServerUrl).origin;
    log.info("renderer.development", { origin: rendererOrigin });
  } else {
    rendererServer = await startRendererServer({ root: stagedWebRoot(), log });
    rendererOrigin = rendererServer.origin;
  }

  const cloudConfig = resolveCloudConfig();
  // Before the window exists, so a restored session is already known when the frontend first renders and
  // the sign-in screens are not shown to someone who is signed in.
  const cloud = await startCloud(cloudConfig, () => mainWindow, rendererOrigin);
  cloudHandlers = cloud.handlers;

  const preloadPath = join(import.meta.dirname, "preload.cjs");
  const windowOptions = {
    rendererOrigin,
    preloadPath,
    appVersion: app.getVersion(),
    apiOrigin: cloudConfig.apiOrigin,
    log,
  };

  /**
   * Raises the workspace at a path, building the window if it is gone — which on macOS it often is,
   * because closing the last window does not quit the app. This is what the Vault panel's links out of
   * itself do, and what Dock activation does.
   */
  const showWorkspace = (path: string = WORKSPACE_PATH): void => {
    const existing = mainWindow;
    if (existing && !existing.isDestroyed()) {
      void existing.loadURL(`${rendererOrigin}${path}`);
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    const reopened = createMainWindow(windowOptions);
    mainWindow = reopened;
    reopened.once("closed", () => {
      mainWindow = null;
    });
    void reopened.loadURL(`${rendererOrigin}${path}`);
  };

  // The quick-access panel and its menu-bar item. Built before the IPC registry, because the registry
  // refuses the panel's channels from any sender but this window; and before the tray, which it reads
  // the anchor from — lazily, since the tray is built from the panel in turn.
  const smoke = smokeCapturePath();
  if (!smoke) {
    vaultPanel = createVaultPanelWindow({
      ...windowOptions,
      anchor: () => vaultTray?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 },
      relockVault: cloud.relockVault,
      onStateChange: () => vaultTray?.refresh(),
    });
    vaultTray = createVaultTray({ log, panel: vaultPanel, openApp: showWorkspace });
  }

  registerIpcHandlers({
    rendererOrigin,
    log,
    cloud: cloudHandlers,
    vaultPanel,
    openAppPath: showWorkspace,
  });

  const window = createMainWindow(windowOptions);
  mainWindow = window;
  window.once("closed", () => {
    mainWindow = null;
  });

  // macOS reopens a window on Dock activation; the server is already running, so this is cheap. The
  // Vault panel is not counted: it is a popover, and activating the Dock icon asks for the workspace.
  app.on("activate", () => {
    const workspaceOpen = BrowserWindow.getAllWindows().some(
      (candidate) => !vaultPanel?.ownsSender(candidate.webContents.id),
    );
    if (workspaceOpen) return;
    showWorkspace();
  });

  /*
   * The workspace, not `/`. The staged server is the whole web app, and `/` is its public homepage —
   * so the shell opened on the marketing site, which is a page for people who have not installed the
   * app. `/now` is the list, and the gate sends an unauthenticated visitor to `/signin` from there.
   */
  await window.loadURL(`${rendererOrigin}${WORKSPACE_PATH}`);
  log.info("window.loaded", { url: window.webContents.getURL() });

  if (smoke) {
    await captureWindow(window, smoke, log);
    app.quit();
  }
}

/**
 * Chained off `whenReady`, never awaited at the top level. Electron emits `ready` while this ESM entry
 * module is still being evaluated, so `await app.whenReady()` here would wait for an event that is
 * itself waiting for evaluation to finish, and the app would start with no window and no error.
 */
void app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    log.error("startup.failed", { message: error instanceof Error ? error.message : "unknown" });
    app.exit(1);
  });
