/**
 * The shape `contextBridge` exposes as `window.symplist`. The renderer is the deployed web frontend,
 * so every screen must keep working when this object is absent: feature detection (`window.symplist`)
 * is the only switch between the browser build and the desktop build.
 *
 * apps/web consumes this type by structural match rather than by importing it — the web app must not
 * depend on the desktop package — so changing a method here is a change to a published contract.
 */
import type {
  AssistantEvent,
  AssistantOption,
  AssistantSession,
  AssistantStatus,
  AssistantTimelineEntry,
  AssistantTurnResult,
} from "./assistant.ts";
import type { CloudResponsePayload, HostInfo, McpAccessInfo } from "./ipc.ts";
import type { KeychainProvider, KeychainStatus } from "./keychain.ts";

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
    fetch(input: string, init?: RequestInit): Promise<CloudResponsePayload>;
    /**
     * The session ended without this page asking: revoked from another device, expired, or refused when
     * the app restored it on launch. Returns the unsubscribe function. Sign-out does not fire it — the
     * page that asked for it is already navigating.
     */
    onSessionEnded(listener: () => void): () => void;
  };
  /**
   * The assistant, running as a child process on this machine over ACP.
   *
   * `prompt` is one call that settles when the turn ends — `session/prompt` has no earlier
   * settlement — and everything that happens during the turn arrives on `onEvent`. There is no token
   * stream to subscribe to: `dsh-acp` emits its message chunks from *committed* assistant messages
   * and keeps raw provider deltas off the wire, so a UI built around a typewriter would sit still
   * between tool calls. Render the tool timeline instead; that is where a turn's time goes.
   */
  readonly assistant: {
    /** Whether a turn could succeed, and which recovery to offer when it could not. */
    status(): Promise<AssistantStatus>;
    /** Open a conversation's session, rejoining a previous one when the agent still holds it. */
    open(conversationId: string): Promise<AssistantSession | null>;
    /** What this conversation has accumulated in this run, for a component that just mounted. */
    timeline(conversationId: string): Promise<readonly AssistantTimelineEntry[]>;
    /** Send one turn. Resolves at the stop reason, which may be `cancelled`. */
    prompt(conversationId: string, text: string): Promise<AssistantTurnResult>;
    /** Cancel the turn in flight; the pending `prompt` then settles with `cancelled`. */
    cancel(conversationId: string): Promise<boolean>;
    /** Close the session. The child process lives on until it goes idle. */
    close(conversationId: string): Promise<boolean>;
    /**
     * Change one session configuration option — in practice the model. Returns the complete option
     * state, because changing one option can change what the others admit.
     */
    setOption(
      conversationId: string,
      configId: string,
      value: string,
    ): Promise<readonly AssistantOption[]>;
    /**
     * Answer an approval the agent is blocked on. `null` answers "cancelled", which is what ACP
     * requires when the user declines to decide rather than choosing a rejection option.
     */
    decide(requestId: string, optionId: string | null): Promise<boolean>;
    /** Everything above, as it happens. Returns the unsubscribe function. */
    onEvent(listener: (event: AssistantEvent) => void): () => void;
  };
  readonly host: {
    /** Version, platform and whether the assistant is available. */
    info(): Promise<HostInfo>;
    /**
     * Hands an http(s) or mailto link to the user's default application. The renderer cannot open a
     * window of its own, so this is the only way out of the app.
     */
    openExternal(url: string): Promise<boolean>;
  };
  /**
   * The device's model provider keys. Settings → Models is the only screen that uses this, and it can
   * do exactly three things: ask which providers have a key, add one, and remove one. Nothing returns a
   * key — see `shared/keychain.ts` for why that absence is the contract rather than an omission.
   */
  readonly keychain: {
    status(): Promise<KeychainStatus>;
    set(provider: KeychainProvider, key: string): Promise<KeychainStatus>;
    clear(provider: KeychainProvider): Promise<KeychainStatus>;
  };
  /**
   * Whether the assistant's Symplist tools can reach the workspace.
   *
   * The renderer reads this to show a reconnect banner beside the chat and to offer the repair. It gets no
   * way to make an MCP call itself, and that is the design: the workspace screens go through `/v1` over
   * `cloud.fetch` exactly as they do in the browser, and MCP is the agent's path alone — which keeps the
   * grant's document retrieval budget for the agent and the workspace screens off the api's D1 lane.
   */
  readonly mcp: {
    state(): Promise<McpAccessInfo>;
    /**
     * Re-checks the grant against the cloud. The renderer calls it on window focus, mirroring the
     * `visibilitychange` refresh the web connections screen already does, so a revoke performed in the
     * browser shows up here in about a second rather than at the agent's next tool call.
     */
    reconcile(): Promise<McpAccessInfo>;
    /** Mints a replacement grant and retires the dead one: the repair behind the reconnect banner. */
    reconnect(): Promise<McpAccessInfo>;
    /** Pushed whenever the answer above changes. Returns the unsubscribe function. */
    onChanged(listener: (state: McpAccessInfo) => void): () => void;
  };
}
