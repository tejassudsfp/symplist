/**
 * Symplist desktop: application lifecycle.
 *
 * Three processes live in this app. **main** (this file) owns everything privileged: the renderer's
 * Next server, the cloud session and the keychain it is stored in, and the assistant child.
 * **renderer** is the unchanged apps/web frontend with no privileges and no network reach of its own.
 * **dsh** is the assistant, a child process driven over ACP.
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
import { McpGrantStore } from "./cloud/mcp-grant.ts";
import { CloudSession } from "./cloud/session-state.ts";
import { type CloudConfig, resolveCloudConfig } from "./config.ts";
import { readProviderKeys } from "./harness/provider-keys.ts";
import { transcriptSessionBook } from "./harness/session-book.ts";
import { HarnessSupervisor } from "./harness/supervisor.ts";
import { registerIpcHandlers } from "./ipc.ts";
import { createMainLog } from "./log.ts";
import { deviceGrantSource, McpAccess } from "./mcp/index.ts";
import { type RendererServer, startRendererServer } from "./next-server.ts";
import { SecretStore } from "./secrets/secret-store.ts";
import { captureWindow, smokeCapturePath } from "./smoke.ts";
import { TranscriptStore } from "./transcripts.ts";
import { createMainWindow } from "./window.ts";

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
let mcpAccess: McpAccess | null = null;
let assistant: HarnessSupervisor | null = null;
let transcripts: TranscriptStore | null = null;
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
// Set before `whenReady`, because Electron resolves userData on first use.
app.setName("Symplist");

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  // macOS keeps the app in the Dock with no window; every other platform quits.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  const server = rendererServer;
  rendererServer = null;
  if (server) void server.stop();
  // A request still in flight would resolve into a window that no longer exists.
  cloudHandlers?.abortAll();
  // The relay outlives the window otherwise, and a listener holding a live bearer must not.
  const mcp = mcpAccess;
  mcpAccess = null;
  if (mcp) void mcp.stop();
  // Each harness child is a resident Node process holding the account's provider key in its
  // environment. Nothing may outlive the app, so quit ends stdin — `dsh-acp-app` binds EOF to a
  // bounded shutdown — then escalates to SIGTERM and SIGKILL on a timer.
  const harness = assistant;
  assistant = null;
  if (harness) void harness.dispose();
  // Closed after the harness, because disposing a child can still land a final update to append.
  const store = transcripts;
  transcripts = null;
  store?.close();
});

/** The staged web build: under `Resources` when packaged, under `build/` when run from the workspace. */
function stagedWebRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(import.meta.dirname, "..", "build", "web");
}

/**
 * The directory the assistant's shell and filesystem are scoped to.
 *
 * `dsh-base` pins `sandbox-policy.workspaceRoot` and `fs-sandbox` to the child's `process.cwd()`, so
 * this is the whole of what the agent can touch. It is the user's home by default rather than the
 * app bundle or `/`: an agent that can run `ls` is only useful over the files the user actually works
 * on, and a root of `/` would hand a model the entire disk on its first turn. The override exists for
 * development and for the day the product lets a workspace name its own directory.
 */
function resolveWorkspaceRoot(): string {
  return process.env.SYMPLIST_DESKTOP_WORKSPACE_ROOT ?? app.getPath("home");
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
): Promise<{
  readonly handlers: CloudHandlers;
  readonly mcp: McpAccess;
  /** Shared with the assistant, which reads the device's provider keys out of the same store. */
  readonly store: SecretStore;
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
  const grants = new McpGrantStore({ apiOrigin: config.apiOrigin, http, store, log });
  const cloudSession = new CloudSession({
    apiOrigin: config.apiOrigin,
    jar,
    store,
    http,
    log,
    credentials: grants,
    onSessionEnded: () => {
      // The web app turns this into `markSignedOut({ expired: true })`, which routes to sign-in with the
      // notice it already has for a session that ended on its own.
      rendererWindow()?.webContents.send(ipcEvents.cloudSessionEnded);
    },
  });
  if (!store.isAvailable()) {
    // No keychain means no persistence at all, and never a plaintext file. Users experience this as
    // signing in on every launch, so it is logged plainly rather than left to be guessed at.
    log.warn("cloud.persistence_unavailable");
  }
  const outcome = await cloudSession.restore();
  log.info("cloud.restore", { outcome, apiOrigin: config.apiOrigin });

  /*
   * The assistant's path to the workspace. It shares this transport and this grant store rather than
   * holding a second copy of either: one credential, one cookie jar, one place a reviewer looks. The relay
   * it starts is what the harness points at — the grant key itself never leaves this process.
   */
  const mcp = new McpAccess({
    grants: deviceGrantSource(grants, () => cloudSession.currentIdentity()),
    http,
    target: `${config.apiOrigin}/mcp`,
    log,
    onChange: (state) => {
      rendererWindow()?.webContents.send(ipcEvents.mcpAccessChanged, state);
    },
  });
  await mcp.start();
  return {
    handlers: createCloudHandlers({
      apiOrigin: config.apiOrigin,
      http,
      session: cloudSession,
      log,
    }),
    mcp,
    store,
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
  const cloud = await startCloud(cloudConfig, () => mainWindow);
  cloudHandlers = cloud.handlers;
  mcpAccess = cloud.mcp;

  /*
   * The assistant. Constructed unconditionally and cheaply: nothing is spawned until a conversation is
   * opened, and a build with no harness tree answers `available()` false, which is what the chat slot
   * in apps/web mounts on. The workspace root is the directory the agent's shell and filesystem are
   * scoped to — one child per root, and for now there is one root.
   */
  /*
   * The local transcript store, and the only durable record a conversation has: ACP does not replay
   * history and note 18 forbids the cloud holding one again. It also keeps each conversation's ACP
   * session id, which is what lets `tryResume` rejoin a session after a relaunch instead of silently
   * starting a fresh one — see `harness/session-book.ts` for why that distinction is worth the wiring.
   */
  const workspaceRoot = resolveWorkspaceRoot();
  const transcriptStore = new TranscriptStore({
    path: join(app.getPath("userData"), "transcripts.sqlite"),
    log,
  });
  await transcriptStore.open();
  transcripts = transcriptStore;

  const supervisor = new HarnessSupervisor({
    workspaceRoot,
    userData: app.getPath("userData"),
    keyring: { providerKeys: async () => readProviderKeys(cloud.store, log) },
    sessionBook: transcriptSessionBook(transcriptStore, workspaceRoot),
    tools: mcpAccess,
    log,
    emit: (event) => {
      mainWindow?.webContents.send(ipcEvents.assistantEvent, event);
    },
  });
  assistant = supervisor;

  registerIpcHandlers({
    rendererOrigin,
    log,
    assistant: supervisor.available(),
    assistantService: supervisor,
    cloud: cloudHandlers,
    mcp: mcpAccess,
    // The same store the cloud session persists into and `readProviderKeys` reads from: one keychain in
    // this app, and one place to audit what is in it.
    keychain: cloud.store,
    onKeychainChanged: () => {
      /*
       * A harness child receives the provider key in its environment when it is spawned, so a child that
       * started before the key existed can never see it. Restarting makes the next prompt spawn a fresh
       * one that reads the key just added. Without this, adding a key in Settings appears to do nothing
       * until the app is restarted — and nothing tells the user that.
       */
      void supervisor.restart().then(
        () => {
          log.info("assistant.restarted_for_key");
        },
        (error: unknown) => {
          log.warn("assistant.restart_failed", {
            message: error instanceof Error ? error.message : "unknown",
          });
        },
      );
    },
  });

  const window = createMainWindow({
    rendererOrigin,
    preloadPath: join(import.meta.dirname, "preload.cjs"),
    appVersion: app.getVersion(),
    apiOrigin: cloudConfig.apiOrigin,
    log,
  });
  mainWindow = window;
  window.once("closed", () => {
    mainWindow = null;
  });

  // macOS reopens a window on Dock activation; the server is already running, so this is cheap.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    const reopened = createMainWindow({
      rendererOrigin,
      preloadPath: join(import.meta.dirname, "preload.cjs"),
      appVersion: app.getVersion(),
      apiOrigin: cloudConfig.apiOrigin,
      log,
    });
    mainWindow = reopened;
    void reopened.loadURL(rendererOrigin);
  });

  await window.loadURL(rendererOrigin);
  log.info("window.loaded", { url: window.webContents.getURL() });

  const capturePath = smokeCapturePath();
  if (capturePath) {
    await captureWindow(window, capturePath, log);
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
