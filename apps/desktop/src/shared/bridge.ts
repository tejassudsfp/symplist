/**
 * The shape `contextBridge` exposes as `window.symplist`. The renderer is the deployed web frontend,
 * so every screen must keep working when this object is absent: feature detection (`window.symplist`)
 * is the only switch between the browser build and the desktop build.
 *
 * apps/web consumes this type by structural match rather than by importing it — the web app must not
 * depend on the desktop package — so changing a method here is a change to a published contract.
 *
 * It is deliberately two namespaces and nothing more. An earlier version of this app also exposed an
 * assistant, a model-provider keychain and an MCP relay, because Simon ran as a child process beside
 * the window. Note 18 ended that: Symplist publishes its tools over the api's `/mcp` endpoint and the
 * agent is whichever MCP client the person already uses, so the app is a list and the bridge is a
 * transport. Anything added here should have to justify itself against that.
 */
import type { CloudResponsePayload, HostInfo } from "./ipc.ts";

/**
 * A `RequestInit` with the two members that cannot cross `contextBridge` replaced by ones that can.
 *
 * `headers` is a `Headers` and `signal` an `AbortSignal`, and both keep everything on their
 * prototype — so both arrive as `{}`. `headers` losing its entries cost every request its
 * `Content-Type` and CSRF header; `signal` was worse, because `{}` is truthy: the preload then
 * called `signal.addEventListener`, which is not a function, and the throw surfaced in the page as
 * "You appear to be offline" on any request that passed one. A plain object survives the copy, and
 * so does a function — which is what `onAbort` is.
 */
export interface BridgedRequestInit extends Omit<RequestInit, "headers" | "signal"> {
  readonly headers?: Readonly<Record<string, string>>;
  /** Subscribes to abort and answers the unsubscribe. Called at most once per request. */
  readonly onAbort?: (listener: () => void) => () => void;
}

export interface SymplistBridge {
  /**
   * The cloud transport. The renderer does no network of its own: `apps/web`'s `ApiClient` is
   * constructed with an adapter over `cloud.fetch` and `cloud.apiOrigin` as its base URL, and every
   * `/v1` call travels through main, which holds the session cookie and sets the `Origin` header the
   * api requires. There is no sign-in code here — the web app's own screens do that over this
   * transport, unchanged.
   */
  readonly cloud: {
    /** The api origin this app is built against, so the renderer needs no `NEXT_PUBLIC_API_URL`. */
    readonly apiOrigin: string;
    /**
     * Sends a request for a `/v1` URL on `apiOrigin`; anything else is refused in main. `credentials`,
     * `mode` and `redirect` in the init are ignored, because main builds its own request.
     *
     * It takes a URL **string**, and answers with the response as plain data rather than a `Response`.
     * Both halves of that are forced by `contextBridge`, which copies own enumerable properties between
     * worlds: a `URL` argument arrives in the preload as `{}` and resolves to `"/[object Object]"`, and a
     * `Response` built in the preload arrives in the page with no `status`, no headers and no `json()`.
     * `apps/web`'s `getApiClient()` owns both conversions — it stringifies the URL going out and rebuilds
     * a real `Response` coming back, so `ApiClient`'s error envelope parsing, `Retry-After` handling and
     * schema checks are untouched and the browser build keeps passing a `URL` as it always has.
     */
    fetch(input: string, init?: BridgedRequestInit): Promise<CloudResponsePayload>;
    /**
     * The session ended without this page asking: revoked from another device, expired, or refused when
     * the app restored it on launch. Returns the unsubscribe function. Sign-out does not fire it — the
     * page that asked for it is already navigating.
     */
    onSessionEnded(listener: () => void): () => void;
  };
  readonly host: {
    /** Version and platform. */
    info(): Promise<HostInfo>;
    /**
     * Hands an http(s) or mailto link to the user's default application. The renderer cannot open a
     * window of its own, so this is the only way out of the app — and it is how someone reaches the
     * api's `/mcp` documentation to connect their own assistant.
     */
    openExternal(url: string): Promise<boolean>;
  };
}
