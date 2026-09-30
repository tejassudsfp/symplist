/**
 * The shape `contextBridge` exposes as `window.symplist`. The renderer is the deployed web frontend,
 * so every screen must keep working when this object is absent: feature detection (`window.symplist`)
 * is the only switch between the browser build and the desktop build.
 *
 * apps/web consumes this type by structural match rather than by importing it — the web app must not
 * depend on the desktop package — so changing a method here is a change to a published contract.
 *
 * It is deliberately small. An earlier version of this app also exposed an assistant, a model-provider
 * keychain and an MCP relay, because Simon ran as a child process beside the window. Note 18 ended
 * that: Symplist publishes its tools over the api's `/mcp` endpoint and the agent is whichever MCP
 * client the person already uses, so the app is a list and the bridge is a transport. Anything added
 * here has to justify itself against that.
 *
 * `vaultPanel` is the third namespace, and it justifies itself the same way `host` does: it is the
 * shell's own verbs, not the api's. A menu-bar popover that hides on blur, sizes itself to its content,
 * uses the system clipboard and raises the main window is asking for four things a web page cannot do
 * — and it reads the vault over `cloud`, exactly like the workspace's own vault screen.
 */
import type { CloudResponsePayload, HostInfo, VaultPanelReport } from "./ipc.ts";

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
  /**
   * The Vault quick-access panel's shell verbs, present on every page but usable only from the panel
   * window — main refuses these channels from any other sender. The workspace never calls them.
   *
   * It is here rather than in `apps/web` because none of it is a web page's to do: hiding a frameless
   * popover, sizing its window to its content, writing to the system clipboard and taking it off again
   * thirty seconds later, and raising the main window. The vault itself is read over `cloud.fetch` like
   * every other screen, so nothing about the vault's contents passes through this namespace except the
   * one value the person asked to copy.
   */
  readonly vaultPanel: {
    /** Hides the panel. Main then locks what the panel unlocked and answers `onDismissed`. */
    close(): void;
    /** What to draw in the menu bar, and whether closing should lock. */
    report(state: VaultPanelReport): void;
    /** The panel's measured content height; main clamps it and sizes the window. */
    resize(height: number): void;
    /**
     * Puts one vault value on the system clipboard, and takes it off again after thirty seconds if the
     * clipboard still holds it. It is main's clipboard because the renderer has no permission to write
     * one — `hardenSession()` refuses every device permission — and because the timed clear has to
     * outlive a panel that is already hidden.
     */
    copy(value: string): Promise<boolean>;
    /** Raises the main window at one of the paths the panel links to. Main allowlists the path. */
    openApp(path: string): Promise<boolean>;
    /** The panel was shown again. Returns the unsubscribe. */
    onShown(listener: () => void): () => void;
    /** The panel was hidden. Returns the unsubscribe. */
    onDismissed(listener: () => void): () => void;
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
