/**
 * The IPC surface between the renderer (the unchanged Next.js frontend) and the Electron main
 * process. Main and preload are bundled separately, so this module is the only place the two agree
 * on channel names and payload shapes; nothing here may import `electron` or `node:*`.
 *
 * Channels are namespaced `symplist:<group>/<action>`. A group is one main-process service — `host`
 * and `cloud` — and each registers its handlers through `registerIpcHandlers` in `src/main/ipc.ts`,
 * which is where the sender check lives.
 *
 * It is a small surface, and it used to be much larger. The shell carried an assistant, a model-key
 * keychain and an MCP relay, because Simon ran inside this app. Note 18 replaced all of that with one
 * sentence: **Symplist publishes tools, it does not run an agent.** The assistant is whatever MCP
 * client the person already uses, it connects to the api's `/mcp` endpoint over OAuth, and this app
 * is a list — so there is nothing for those channels to do.
 *
 * What is left is the reason the desktop app exists at all: a window, a link out to the operating
 * system, and a cloud transport that main owns because the renderer must hold no session.
 */

/** Every channel the preload bridge is allowed to invoke. */
export const ipcChannels = Object.freeze({
  hostInfo: "symplist:host/info",
  hostOpenExternal: "symplist:host/open-external",
  /** One request to the cloud api, made by main on the renderer's behalf. */
  cloudRequest: "symplist:cloud/request",
  /** Cancels a request in flight, since an `AbortSignal` cannot cross the bridge. */
  cloudAbort: "symplist:cloud/abort",
  /**
   * The Vault quick-access panel, and only that window: `src/main/ipc.ts` refuses these from any other
   * sender. They are shell verbs — hide this window, size it, use the system clipboard, raise the main
   * window — because the panel is a menu-bar popover and none of that is a web page's to do. Every
   * `/v1/vault` call it makes still goes through `cloudRequest` like any other screen's.
   */
  vaultPanelClose: "symplist:vault-panel/close",
  vaultPanelReport: "symplist:vault-panel/report",
  vaultPanelResize: "symplist:vault-panel/resize",
  vaultPanelCopy: "symplist:vault-panel/copy",
  vaultPanelOpenApp: "symplist:vault-panel/open-app",
} as const);

/**
 * Channels main pushes to the renderer. Unlike the rest these are `webContents.send`, not `invoke`, so
 * they are listed apart: nothing registers a handler for them.
 */
export const ipcEvents = Object.freeze({
  /**
   * The cloud session ended without the renderer asking — revoked elsewhere, expired, or refused on a
   * launch that restored it. The web app turns this into `SessionStore.markSignedOut({ expired: true })`,
   * which is the same path a 401 already takes.
   */
  cloudSessionEnded: "symplist:cloud/session-ended",
  /** The Vault panel was shown again. Its window is reused, so this is its "read the state again". */
  vaultPanelShown: "symplist:vault-panel/shown",
  /**
   * The Vault panel was hidden. It forgets everything on screen and locks the vault if it is the one
   * that opened it; main drops the vault cookie either way, so a lock never depends on a live request.
   */
  vaultPanelDismissed: "symplist:vault-panel/dismissed",
} as const);

/** A channel name, used by the main-process registry to reject anything unregistered. */
export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

/** What the renderer may learn about the shell it is running in. */
export interface HostInfo {
  /** Always "desktop": the web build has no bridge at all, so the renderer feature-detects first. */
  readonly runtime: "desktop";
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly electronVersion: string;
}

/** The result of asking the shell to hand a link to the operating system. */
export interface OpenExternalResult {
  readonly opened: boolean;
}

/**
 * What the Vault panel tells the shell about itself: what to draw in the menu bar, whether closing the
 * panel should lock the vault, and who is signed in for the tray menu's last line. It is the person's
 * own address, and main already carries every `/v1/me` response that produced it.
 */
export interface VaultPanelReport {
  readonly unlocked: boolean;
  readonly unlockedHere: boolean;
  readonly email: string | null;
}

/**
 * One request to `/v1`, as plain data. `url` is absolute; main pins it to the api origin and a `/v1/`
 * path before it attaches the session cookie, so the renderer naming another host achieves nothing.
 *
 * `Cookie` is not accepted here and is stripped in main regardless. Bodies are strings because `/v1`
 * speaks JSON; `requestId` exists only so `cloudAbort` has something to name.
 */
export interface CloudRequestPayload {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | null;
}

/**
 * The api's answer, as plain data. `Set-Cookie` is never in `headers`: main consumed it into its own jar,
 * which is the reason the renderer can hold no session token.
 */
export interface CloudResponsePayload {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}
