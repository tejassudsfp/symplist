import { accessChangedEventSchema } from "@symplist/contracts";
import { RealtimeClient, type RealtimeStatus, realtimeUrl } from "@/lib/realtime";
import { clearSharedCsrfToken, getAccessApi } from "./api.ts";
import { SessionStore } from "./session-store.ts";
import { signOut } from "./sign-out.ts";

let sharedStore: SessionStore | null = null;

/** The document's session store over the shared access API. */
export function getSharedSessionStore(): SessionStore {
  sharedStore ??= new SessionStore(getAccessApi());
  return sharedStore;
}

/** Test support: forgets the shared store so the next render starts a fresh session. */
export function resetSharedSessionStoreForTests(): void {
  sharedStore = null;
}

/**
 * Signs the browser out through the shared API and session (the `access.sign_out` action, the gate
 * and account screens all call this), then loads the email entry as a new document.
 */
export function signOutOfBrowser(
  store: SessionStore = getSharedSessionStore(),
): ReturnType<typeof signOut> {
  return signOut({
    api: getAccessApi(),
    clearCsrfToken: clearSharedCsrfToken,
    markSignedOut: () => store.markSignedOut({ expired: false }),
    assign: (href) => window.location.assign(href),
  });
}

/**
 * The desktop shell's session bridge, matched structurally so `apps/web` never imports `apps/desktop`.
 * `onSessionEnded` fires when the Electron main process — which owns the cookie jar — learns the session
 * is gone: a 401 of `auth.session_required` on any request, or a stored session the api refused when the
 * app restored it on launch. Sign-out does not fire it, because the page that asked is already leaving.
 */
interface DesktopSessionBridge {
  onSessionEnded(listener: () => void): () => void;
}

function desktopSessionBridge(): DesktopSessionBridge | null {
  const cloud = (globalThis as { symplist?: { cloud?: unknown } }).symplist?.cloud;
  const candidate = cloud as { onSessionEnded?: unknown } | null | undefined;
  if (typeof candidate?.onSessionEnded !== "function") return null;
  return cloud as DesktopSessionBridge;
}

/**
 * In the desktop app, the realtime socket is off — `RealtimeUpgradeGate` requires an `Origin` a renderer
 * cannot set — so a session revoked from another device would otherwise go unnoticed until the next
 * request or the next window focus. The shell notices it on the very next request it makes and says so
 * here, which lands on the same `markSignedOut({ expired: true })` path a 401 already takes.
 *
 * Returns the unsubscribe function, and a no-op in a browser.
 */
export function connectDesktopSessionEnd(
  store: Pick<SessionStore, "markSignedOut"> = getSharedSessionStore(),
): () => void {
  const bridge = desktopSessionBridge();
  if (!bridge) return () => undefined;
  return bridge.onSessionEnded(() => store.markSignedOut({ expired: true }));
}

/** The subset of the realtime client the access subscription uses (a fake implements it in tests). */
export interface AccessRealtimeClient {
  connect(): void;
  disconnect(): void;
  onStatusChange(listener: (status: RealtimeStatus) => void): () => void;
  subscribeUser: RealtimeClient["subscribeUser"];
}

export interface AccessRealtimeOptions {
  readonly store: Pick<SessionStore, "refresh">;
  /** Builds the socket client; defaults to the configured `NEXT_PUBLIC_WS_URL`, or nothing without one. */
  readonly createClient?: () => AccessRealtimeClient | null;
}

function defaultClient(): AccessRealtimeClient | null {
  const url = realtimeUrl();
  return url ? new RealtimeClient({ url }) : null;
}

/**
 * Listens on the `user` topic for `access.changed` (§7), which every socket receives even when the
 * account is not admitted, and re-reads the identity so each gate routes to the right screen. A close
 * with 4401 (session ended) or 4403 (access lost) also re-reads it: the api answers 401 for an ended
 * session and the current access state otherwise. Returns the disconnect function.
 */
export function connectAccessRealtime(options: AccessRealtimeOptions): () => void {
  let client: AccessRealtimeClient | null;
  try {
    client = (options.createClient ?? defaultClient)();
  } catch {
    client = null;
  }
  if (!client) return () => undefined;
  const active = client;
  const refresh = () => {
    void options.store.refresh();
  };
  const subscription = active.subscribeUser([], {
    onEvent: (frame) => {
      if (frame.type !== "access.changed") return;
      if (!accessChangedEventSchema.safeParse(frame.data).success) return;
      refresh();
    },
  });
  const stopStatus = active.onStatusChange((status) => {
    if (status === "unauthorized" || status === "forbidden") refresh();
  });
  active.connect();
  return () => {
    stopStatus();
    subscription.unsubscribe();
    active.disconnect();
  };
}
