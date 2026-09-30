/**
 * The IPC surface between the renderer (the unchanged Next.js frontend) and the Electron main
 * process. Main and preload are bundled separately, so this module is the only place the two agree
 * on channel names and payload shapes; nothing here may import `electron` or `node:*`.
 *
 * Channels are namespaced `symplist:<group>/<action>`. A group is one main-process service — `host`,
 * `cloud`, `mcp`, `assistant` and `keychain` — and every group registers its handlers through
 * `registerIpcHandlers` in `src/main/ipc.ts`, which is where the sender check lives.
 *
 * A group with more than a couple of channels keeps its own names and payload types in a module
 * beside this one and is merged in below; `assistant.ts` is that, because the harness bridge carries
 * a whole timeline vocabulary that has no business in this file.
 */
import { assistantChannels, assistantEventChannel } from "./assistant.ts";
import { keychainChannels } from "./keychain.ts";

/** Every channel the preload bridge is allowed to invoke. */
export const ipcChannels = Object.freeze({
  hostInfo: "symplist:host/info",
  hostOpenExternal: "symplist:host/open-external",
  /** One request to the cloud api, made by main on the renderer's behalf. */
  cloudRequest: "symplist:cloud/request",
  /** Cancels a request in flight, since an `AbortSignal` cannot cross the bridge. */
  cloudAbort: "symplist:cloud/abort",
  /** Whether the assistant's Symplist tools can reach the workspace. */
  mcpState: "symplist:mcp/state",
  /** Re-checks the device's grant against the cloud; the renderer calls it on window focus. */
  mcpReconcile: "symplist:mcp/reconcile",
  /** Mints a replacement grant and retires the dead one. */
  mcpReconnect: "symplist:mcp/reconnect",
  ...assistantChannels,
  ...keychainChannels,
} as const);

/**
 * Channels main pushes to the renderer. Unlike the rest these are `webContents.send`, not `invoke`, so
 * they are listed apart: nothing registers a handler for them.
 */
export const ipcEvents = Object.freeze({
  /**
   * The assistant's access to the workspace changed — the grant was revoked, expired, re-minted, or the
   * cloud is pacing requests. Pushed rather than polled so a revoke performed in the web UI does not wait
   * for the renderer to ask.
   */
  mcpAccessChanged: "symplist:mcp/access-changed",
  /**
   * The cloud session ended without the renderer asking — revoked elsewhere, expired, or refused on a
   * launch that restored it. The web app turns this into `SessionStore.markSignedOut({ expired: true })`,
   * which is the same path a 401 already takes.
   */
  cloudSessionEnded: "symplist:cloud/session-ended",
  /**
   * One thing happened inside a conversation: a committed message, a thought, a tool call moving
   * through its lifecycle, a changed option set, or an approval the agent is blocked on. Pushed
   * rather than polled because a turn is one `invoke` that settles only at the end — everything the
   * user watches happen arrives here.
   */
  assistantEvent: assistantEventChannel,
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
  /**
   * Whether this build carries the assistant runtime. The chat slot in apps/web mounts on this
   * rather than on the bridge existing, so a shell without a harness shows no chat instead of a
   * chat that cannot reply.
   *
   * It is deliberately *not* readiness: a device with a harness and no provider key still shows
   * chat, because chat is where the "add a key" state belongs. Ask `assistant.status()` for that.
   */
  readonly assistant: boolean;
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

/**
 * Whether the assistant can reach the Symplist workspace, which is a different question from whether the
 * assistant is running: the harness can be alive with its tools dead, and that is exactly the case worth
 * telling the user about rather than letting them watch an agent fail quietly.
 *
 * Three states, kept distinct because collapsing them would lie about what to do next:
 *
 *   - `connected` — the device's MCP grant works.
 *   - `reconnect` — it was revoked or has expired. `notice` says so and the renderer offers the repair.
 *   - `signed_out` — no account, so there is nothing to grant.
 *
 * Nothing here identifies the credential or the relay behind it. `grantId` is the id Settings → Agent
 * connections shows, so a person can match the app's row to the one they are looking at in the web UI.
 */
export interface McpAccessInfo {
  readonly state: "connected" | "reconnect" | "signed_out";
  readonly grantId: string | null;
  readonly expiresAt: number | null;
  /** A sentence for the user when there is something to say, or `null` when all is well. */
  readonly notice: string | null;
}
