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
