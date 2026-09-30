/**
 * The preload bridge. It runs in the renderer process with `contextIsolation` and `sandbox` on, so it
 * has no filesystem, no child processes and no network beyond what main chooses to expose — which is the
 * point. It forwards named channels and nothing else: no raw `ipcRenderer`, no `fetch`, no `spawn`, and
 * never a secret's value.
 *
 * Each namespace is one wrapper per channel registered in `src/main/ipc.ts`. Keep them thin — logic in
 * preload is logic that runs next to untrusted page script.
 *
 * There are two of them, and there used to be five. The assistant, the model-key keychain and the MCP
 * relay left with the embedded agent (note 18): Symplist publishes its tools over the api's `/mcp`
 * endpoint, the agent is whichever client the person already uses, and this app is a list.
 *
 * `cloud` is the largest wrapper and stays as small as it can be for a reason: the only thing it does is
 * turn a `Request` into plain data and hand plain data back. It makes no decisions. Every rule about
 * where a request may go, what header it carries and which cookie is attached lives in main, on the
 * other side of the process boundary, because this code is reachable from the page.
 *
 * Nothing here returns a web platform object, and that is a constraint rather than a preference:
 * `contextBridge` copies own enumerable properties into the page's world, so anything that keeps its
 * state in internal slots — `Response`, `Headers`, `URL` — arrives as an empty object. Plain records,
 * arrays, strings and numbers are the whole vocabulary of this file.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { BridgedRequestInit, SymplistBridge } from "../shared/bridge.ts";
import type {
  CloudRequestPayload,
  CloudResponsePayload,
  HostInfo,
  VaultPanelReport,
} from "../shared/ipc.ts";
import { ipcChannels, ipcEvents } from "../shared/ipc.ts";

/** A value passed as `additionalArguments` by the window, since `app` is a main-process API. */
function argument(name: string, fallback: string): string {
  const prefix = `--symplist-${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

/** The version, read the same way. */
function appVersionArgument(): string {
  return argument("app-version", "0.0.0");
}

/**
 * The api origin, read synchronously because `getApiClient()` in apps/web builds its client during a
 * render and cannot await an IPC round trip. Main is still the authority: it pins every request to its
 * own configured origin, so a wrong value here produces a refusal rather than a request somewhere else.
 */
const apiOrigin = argument("api-origin", "");

let nextRequestId = 0;

/**
 * Subscribes to a payload-free event from main and answers the unsubscribe. The listener is wrapped
 * rather than passed through, so nothing main sends can reach the page through its arguments.
 */
function subscribe(channel: string, listener: () => void): () => void {
  const handler = (): void => listener();
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/**
 * Serialises a request, sends it, and answers with the response as plain data.
 *
 * `Request` does the header and body normalisation so this wrapper does not have to: it resolves a
 * relative URL, lowercases header names and turns any `BodyInit` into text. A `null` body for a method
 * that takes one is preserved as `null` rather than an empty string, because the two are different to
 * the api. Building it here is safe — it is consumed here, and never crosses into the page.
 */
async function cloudFetch(
  input: RequestInfo | URL,
  init?: BridgedRequestInit,
): Promise<CloudResponsePayload> {
  // `onAbort` is ours and not part of `RequestInit`; `new Request` would ignore it, but it is taken
  // out explicitly so the request is built from web-standard fields only.
  const { onAbort: subscribeAbort, ...requestInit } = init ?? {};
  const request = new Request(input, requestInit as RequestInit);
  nextRequestId += 1;
  const requestId = `r${nextRequestId}`;
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
  const payload: CloudRequestPayload = {
    requestId,
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    body: body === null || body.length === 0 ? null : body,
  };

  /*
   * Abort arrives as a subscribe function, not an `AbortSignal`.
   *
   * A signal cannot cross `contextBridge`: it keeps `aborted` and `addEventListener` on its
   * prototype, so it arrives as `{}` — truthy, with no `addEventListener` to call. That threw here,
   * the bridged fetch rejected, and `ApiClient` reported it as `ApiNetworkError`, which the pages
   * render as "You appear to be offline". Every screen that passed a signal was unreachable on
   * first load while its retry, which passes none, worked — which is exactly how it looked.
   */
  const onAbort = (): void => {
    ipcRenderer.send(ipcChannels.cloudAbort, requestId);
  };
  const unsubscribeAbort = subscribeAbort ? subscribeAbort(onAbort) : null;

  try {
    // Returned as plain data, and the renderer builds the `Response`. It cannot be built here: preload
    // runs in the isolated world, `contextBridge` copies only own enumerable properties across to the
    // page, and a `Response` keeps everything — `status`, `ok`, `headers`, `json()` — on its prototype.
    // One constructed here therefore arrives in `apps/web` as an empty object, and every api call fails
    // with no error worth reading. `status`, a header list and a body string all clone cleanly.
    return (await ipcRenderer.invoke(ipcChannels.cloudRequest, payload)) as CloudResponsePayload;
  } finally {
    unsubscribeAbort?.();
  }
}

const bridge: SymplistBridge = {
  cloud: {
    apiOrigin,
    fetch: cloudFetch,
    onSessionEnded: (listener: () => void): (() => void) =>
      subscribe(ipcEvents.cloudSessionEnded, listener),
  },
  vaultPanel: {
    close: (): void => {
      ipcRenderer.send(ipcChannels.vaultPanelClose);
    },
    report: (state: VaultPanelReport): void => {
      // Sent as a plain record, which is the only shape that survives the copy between worlds.
      ipcRenderer.send(ipcChannels.vaultPanelReport, {
        unlocked: state.unlocked,
        unlockedHere: state.unlockedHere,
        email: state.email,
      });
    },
    resize: (height: number): void => {
      ipcRenderer.send(ipcChannels.vaultPanelResize, height);
    },
    copy: async (value: string): Promise<boolean> =>
      (await ipcRenderer.invoke(ipcChannels.vaultPanelCopy, value)) as boolean,
    openApp: async (path: string): Promise<boolean> =>
      (await ipcRenderer.invoke(ipcChannels.vaultPanelOpenApp, path)) as boolean,
    onShown: (listener: () => void): (() => void) => subscribe(ipcEvents.vaultPanelShown, listener),
    onDismissed: (listener: () => void): (() => void) =>
      subscribe(ipcEvents.vaultPanelDismissed, listener),
  },
  host: {
    info: async (): Promise<HostInfo> => {
      const info = (await ipcRenderer.invoke(ipcChannels.hostInfo)) as HostInfo;
      // The main process is the authority on everything but the version, which it already handed us.
      return { ...info, appVersion: info.appVersion || appVersionArgument() };
    },
    openExternal: async (url: string): Promise<boolean> =>
      (await ipcRenderer.invoke(ipcChannels.hostOpenExternal, url)) as boolean,
  },
};

contextBridge.exposeInMainWorld("symplist", bridge);
