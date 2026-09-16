"use client";

import type { AccessLevel, AccessState, MeResponse, UserId, UserRole } from "@symplist/contracts";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { clearSharedCsrfToken, useAccessApi } from "./api.ts";
import {
  AdminRequired,
  Redirecting,
  SessionExpired,
  SessionLoadFailed,
  SessionLoading,
  SignOutFeedback,
  useSignOutState,
} from "./gate/session-states.tsx";
import {
  destinationPath,
  navigateAcrossGroups,
  PAUSED_PATH,
  preserveConnectionCallback,
  signInPathFor,
} from "./navigation.ts";
import { connectAccessRealtime, getSharedSessionStore } from "./session-runtime.ts";
import { destinationFor, type SessionSnapshot, type SessionStore } from "./session-store.ts";
import { signOut as runSignOut } from "./sign-out.ts";

/*
 * Session seam (§2.3), implemented by the access feature (§5.1, §5.4). `SessionProvider` resolves the
 * signed-in person and their access state from `GET /v1/me` and keeps it current from the realtime
 * `access.changed` event; `SessionGate` sends anyone who fails its level to sign-in, the beta gate,
 * paused access or onboarding. The api remains the only authority: the gate decides what renders,
 * never what is allowed.
 */

export type SessionStatus = "loading" | "signed_out" | "signed_in";

/** The signed-in person. */
export interface SessionUser {
  readonly id: UserId;
  /** The saved display name, or the email address until onboarding saves one. */
  readonly displayName: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface Session {
  readonly status: SessionStatus;
  /** Present when `status` is `signed_in`. */
  readonly user?: SessionUser;
  /** The account's access fields (§5.4); present when `status` is `signed_in`. */
  readonly access?: AccessState;
}

/** Controls for access screens: the full identity body and ways to change it. */
export interface SessionControls {
  readonly snapshot: SessionSnapshot;
  readonly me: MeResponse | null;
  /** Reads `GET /v1/me` again (Check access). */
  refresh(): Promise<SessionSnapshot>;
  /** Applies an identity the api just returned. */
  setMe(me: MeResponse): void;
  /** Signs out through the api and loads the email entry. */
  signOut(): Promise<"signed_out" | "failed" | "in_progress">;
}

interface SessionContextValue {
  readonly session: Session;
  readonly controls: SessionControls;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const INTERRUPTED_KEY = "symplist.access.interrupted";

/** Marks that access changed while protected content was open, for the paused screen's explanation. */
export function rememberInterruption(): void {
  try {
    window.sessionStorage.setItem(INTERRUPTED_KEY, "1");
  } catch {
    // Without session storage the paused screen shows its initial-navigation copy.
  }
}

/** Reads and clears the interruption mark. */
export function takeInterruption(): boolean {
  try {
    const value = window.sessionStorage.getItem(INTERRUPTED_KEY);
    window.sessionStorage.removeItem(INTERRUPTED_KEY);
    return value === "1";
  } catch {
    return false;
  }
}

function sessionFromSnapshot(snapshot: SessionSnapshot): Session {
  if (snapshot.phase !== "signed_in" || !snapshot.me) {
    return { status: snapshot.phase === "signed_in" ? "loading" : snapshot.phase };
  }
  const { user, access } = snapshot.me;
  return {
    status: "signed_in",
    user: {
      id: user.id,
      displayName: user.displayName ?? user.email,
      email: user.email,
      role: user.role,
    },
    access,
  };
}

/** A fixed session as the identity body the api would return, for previews and tests. */
function snapshotFromSession(session: Session): SessionSnapshot {
  if (session.status !== "signed_in" || !session.user || !session.access) {
    return {
      phase: session.status === "signed_in" ? "loading" : session.status,
      me: null,
      loadError: null,
      expired: false,
      accessRevision: 0,
    };
  }
  return {
    phase: "signed_in",
    me: {
      user: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName || null,
        role: session.user.role,
      },
      access: session.access,
      destination: destinationFor(session.access),
      betaAccessRequired: true,
    },
    loadError: null,
    expired: false,
    accessRevision: 0,
  };
}

const loadingSnapshot: SessionSnapshot = {
  phase: "loading",
  me: null,
  loadError: null,
  expired: false,
  accessRevision: 0,
};

function noopSubscribe(): () => void {
  return () => undefined;
}

/** How stale the identity may be before a returning tab reads it again. */
const VISIBILITY_REFRESH_MS = 60_000;

export interface SessionProviderProps {
  readonly children: ReactNode;
  /** A fixed session used instead of the resolved one, for tests and previews. */
  readonly value?: Session;
  /** The store to resolve the session with; defaults to the document's shared store. */
  readonly store?: SessionStore;
}

/** Mounted once at the root by `AppProviders`, so every route group can read the session. */
export function SessionProvider({ children, value, store }: SessionProviderProps) {
  const liveStore = useMemo<SessionStore | null>(() => {
    if (value) return null;
    if (store) return store;
    return typeof window === "undefined" ? null : getSharedSessionStore();
  }, [value, store]);

  const fixedSnapshot = useMemo(() => (value ? snapshotFromSession(value) : null), [value]);
  const liveSnapshot = useSyncExternalStore(
    liveStore?.subscribe ?? noopSubscribe,
    liveStore ? liveStore.getSnapshot : () => loadingSnapshot,
    () => loadingSnapshot,
  );
  const snapshot = fixedSnapshot ?? liveSnapshot;

  useEffect(() => {
    liveStore?.start();
  }, [liveStore]);

  const signedIn = snapshot.phase === "signed_in";
  const userId = snapshot.me?.user.id;
  const generation = snapshot.me?.access.accessGeneration;
  useEffect(() => {
    if (!liveStore || !signedIn || !userId) return;
    // A new socket per generation: a close with 4403 stops reconnecting until access changes again.
    void generation;
    return connectAccessRealtime({ store: liveStore });
  }, [liveStore, signedIn, userId, generation]);

  useEffect(() => {
    if (!liveStore) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const current = liveStore.getSnapshot();
      if (current.phase !== "signed_in") return;
      if (liveStore.ageMs() >= VISIBILITY_REFRESH_MS) void liveStore.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [liveStore]);

  const api = useAccessApi();
  const signOut = useCallback(() => {
    const store = liveStore ?? getSharedSessionStore();
    return runSignOut({
      api,
      clearCsrfToken: clearSharedCsrfToken,
      markSignedOut: () => store.markSignedOut({ expired: false }),
      assign: (href) => window.location.assign(href),
    });
  }, [api, liveStore]);

  const contextValue = useMemo<SessionContextValue>(
    () => ({
      session: value ?? sessionFromSnapshot(snapshot),
      controls: {
        snapshot,
        me: snapshot.me,
        refresh: liveStore ? () => liveStore.refresh() : async () => snapshot,
        setMe: liveStore ? (me) => liveStore.setMe(me) : () => undefined,
        signOut,
      },
    }),
    [value, snapshot, liveStore, signOut],
  );

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
      <SignOutFeedback
        onRetry={() => {
          void signOut();
        }}
      />
    </SessionContext.Provider>
  );
}

function useSessionContext(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}

/** The current session. Throws outside `SessionProvider`. */
export function useSession(): Session {
  return useSessionContext().session;
}

/** The identity body and session controls for access screens. Throws outside `SessionProvider`. */
export function useSessionControls(): SessionControls {
  return useSessionContext().controls;
}

export interface SessionGateProps {
  readonly children: ReactNode;
  /** The §5.4 guard level every route inside the gate needs. */
  readonly require: AccessLevel;
}

export type GateDecision =
  | { readonly kind: "render" }
  | { readonly kind: "loading" }
  | { readonly kind: "load_failed"; readonly error: NonNullable<SessionSnapshot["loadError"]> }
  | { readonly kind: "expired" }
  | { readonly kind: "sign_in" }
  | { readonly kind: "redirect"; readonly href: string }
  | { readonly kind: "admin_required" };

/** What a gate at `level` shows for a session (§5.4 levels over the api's `destination`). */
export function gateDecision(snapshot: SessionSnapshot, level: AccessLevel): GateDecision {
  if (snapshot.phase === "loading") {
    return snapshot.loadError
      ? { kind: "load_failed", error: snapshot.loadError }
      : { kind: "loading" };
  }
  if (snapshot.phase === "signed_out")
    return snapshot.expired ? { kind: "expired" } : { kind: "sign_in" };
  const me = snapshot.me;
  if (!me) return { kind: "loading" };
  if (level === "identity") return { kind: "render" };
  if (me.destination !== "app") return { kind: "redirect", href: destinationPath(me) };
  if (level === "admin" && me.user.role !== "admin") return { kind: "admin_required" };
  return { kind: "render" };
}

function currentLocation(pathname: string | null): string {
  if (typeof window === "undefined") return pathname ?? "/";
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Guards a route group at an access level: `identity` for the gate and onboarding groups, `admitted`
 * for the app, `admin` for administration. Children render only while the session satisfies the
 * level, so a locked, paused or signed-out person never sees protected content behind an overlay
 * (beta_gate.md); when access changes during use the content is replaced by the right screen at once.
 */
export function SessionGate({ children, require }: SessionGateProps) {
  const { controls } = useSessionContext();
  const { snapshot } = controls;
  const router = useRouter();
  const pathname = usePathname();
  const signOutState = useSignOutState();
  const [retrying, setRetrying] = useState(false);
  const decision = gateDecision(snapshot, require);
  const rendered = useRef(false);
  if (decision.kind === "render") rendered.current = true;

  const redirectHref =
    decision.kind === "redirect"
      ? preserveConnectionCallback(decision.href, currentLocation(pathname))
      : decision.kind === "sign_in"
        ? signInPathFor(currentLocation(pathname))
        : null;

  useEffect(() => {
    if (!redirectHref || signOutState.kind === "signing_out") return;
    if (rendered.current && redirectHref === PAUSED_PATH) rememberInterruption();
    navigateAcrossGroups(router, redirectHref, { replace: true });
  }, [redirectHref, router, signOutState.kind]);

  switch (decision.kind) {
    case "render":
      return children;
    case "loading":
      return <SessionLoading />;
    case "load_failed":
      return (
        <SessionLoadFailed
          error={decision.error}
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            void controls.refresh().finally(() => setRetrying(false));
          }}
        />
      );
    case "expired":
      return <SessionExpired returnPath={currentLocation(pathname)} />;
    case "sign_in":
      return <Redirecting label="Opening sign-in…" />;
    case "redirect":
      return <Redirecting label="Opening your account…" />;
    case "admin_required":
      return <AdminRequired />;
  }
}
