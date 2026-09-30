/**
 * The preload bridge. It runs in the renderer process with `contextIsolation` and `sandbox` on, so it
 * has no filesystem, no child processes and no network beyond what main chooses to expose — which is the
 * point. It forwards named channels and nothing else: no raw `ipcRenderer`, no `fetch`, no `spawn`, and
 * never a secret's value.
 *
 * Each namespace is one wrapper per channel registered in `src/main/ipc.ts`. Keep them thin — logic in
 * preload is logic that runs next to untrusted page script.
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
import type {
  AssistantEvent,
  AssistantOption,
  AssistantSession,
  AssistantStatus,
  AssistantTimelineEntry,
  AssistantTurnResult,
} from "../shared/assistant.ts";
import type { BridgedRequestInit, SymplistBridge } from "../shared/bridge.ts";
import type {
  CloudRequestPayload,
  CloudResponsePayload,
  HostInfo,
  McpAccessInfo,
} from "../shared/ipc.ts";
import { ipcChannels, ipcEvents } from "../shared/ipc.ts";
import type { KeychainProvider, KeychainStatus } from "../shared/keychain.ts";

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
  assistant: {
    status: async (): Promise<AssistantStatus> =>
      (await ipcRenderer.invoke(ipcChannels.assistantStatus)) as AssistantStatus,
    open: async (conversationId: string): Promise<AssistantSession | null> =>
      (await ipcRenderer.invoke(
        ipcChannels.assistantOpen,
        conversationId,
      )) as AssistantSession | null,
    timeline: async (conversationId: string): Promise<readonly AssistantTimelineEntry[]> =>
      (await ipcRenderer.invoke(
        ipcChannels.assistantTimeline,
        conversationId,
      )) as readonly AssistantTimelineEntry[],
    prompt: async (conversationId: string, text: string): Promise<AssistantTurnResult> =>
      (await ipcRenderer.invoke(
        ipcChannels.assistantPrompt,
        conversationId,
        text,
      )) as AssistantTurnResult,
    cancel: async (conversationId: string): Promise<boolean> =>
      (await ipcRenderer.invoke(ipcChannels.assistantCancel, conversationId)) as boolean,
    close: async (conversationId: string): Promise<boolean> =>
      (await ipcRenderer.invoke(ipcChannels.assistantClose, conversationId)) as boolean,
    setOption: async (
      conversationId: string,
      configId: string,
      value: string,
    ): Promise<readonly AssistantOption[]> =>
      (await ipcRenderer.invoke(
        ipcChannels.assistantSetOption,
        conversationId,
        configId,
        value,
      )) as readonly AssistantOption[],
    decide: async (requestId: string, optionId: string | null): Promise<boolean> =>
      (await ipcRenderer.invoke(ipcChannels.assistantDecide, requestId, optionId)) as boolean,
    onEvent: (listener: (event: AssistantEvent) => void): (() => void) => {
      // The payload is main's own tagged union, built in `src/main/harness/`, and carries no
      // credential: a provider key never leaves the keyring except into the child's environment.
      const handler = (_event: unknown, event: AssistantEvent): void => listener(event);
      ipcRenderer.on(ipcEvents.assistantEvent, handler);
      return () => {
        ipcRenderer.removeListener(ipcEvents.assistantEvent, handler);
      };
    },
  },
  cloud: {
    apiOrigin,
    fetch: cloudFetch,
    onSessionEnded: (listener: () => void): (() => void) => {
      // The event carries no payload, so nothing from main can reach the page through this listener.
      const handler = (): void => listener();
      ipcRenderer.on(ipcEvents.cloudSessionEnded, handler);
      return () => {
        ipcRenderer.removeListener(ipcEvents.cloudSessionEnded, handler);
      };
    },
  },
  keychain: {
    // Three thin wrappers, and no fourth: there is no channel that reads a key back, so there is
    // nothing here that could return one.
    status: async (): Promise<KeychainStatus> =>
      (await ipcRenderer.invoke(ipcChannels.keychainStatus)) as KeychainStatus,
    set: async (provider: KeychainProvider, key: string): Promise<KeychainStatus> =>
      (await ipcRenderer.invoke(ipcChannels.keychainSet, provider, key)) as KeychainStatus,
    clear: async (provider: KeychainProvider): Promise<KeychainStatus> =>
      (await ipcRenderer.invoke(ipcChannels.keychainClear, provider)) as KeychainStatus,
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
  mcp: {
    state: async (): Promise<McpAccessInfo> =>
      (await ipcRenderer.invoke(ipcChannels.mcpState)) as McpAccessInfo,
    reconcile: async (): Promise<McpAccessInfo> =>
      (await ipcRenderer.invoke(ipcChannels.mcpReconcile)) as McpAccessInfo,
    reconnect: async (): Promise<McpAccessInfo> =>
      (await ipcRenderer.invoke(ipcChannels.mcpReconnect)) as McpAccessInfo,
    onChanged: (listener: (state: McpAccessInfo) => void): (() => void) => {
      // The payload is main's own `McpAccessState`, which holds no credential — see `src/main/mcp/index.ts`.
      const handler = (_event: unknown, state: McpAccessInfo): void => listener(state);
      ipcRenderer.on(ipcEvents.mcpAccessChanged, handler);
      return () => {
        ipcRenderer.removeListener(ipcEvents.mcpAccessChanged, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("symplist", bridge);
