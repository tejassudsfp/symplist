import { createBrowserAnalytics } from "@symplist/analytics";
import { resetAppearanceForSignOut } from "@/theme/appearance-client";
import type { AccessApi } from "./api.ts";
import { problemOf } from "./errors.ts";
import { SIGN_IN_PATH } from "./navigation.ts";

/** Sign-out progress for the profile menu and account screens (profile_menu.md). */
export type SignOutState =
  | { readonly kind: "idle" }
  /** Leaving the signed-in app: signing out, or finishing an accepted account deletion. */
  | { readonly kind: "signing_out"; readonly reason: "sign_out" | "account_deleted" }
  | { readonly kind: "failed"; readonly reason: "network" | "unexpected" };

/** A feature's cleanup for protected state it keeps in the browser, run before leaving the app. */
export type SignOutCleanup = () => void | Promise<void>;

const cleanups = new Set<SignOutCleanup>();

/**
 * Registers browser cleanup that must run on sign-out, for example the analytics feature resetting a
 * loaded posthog-js client (§15). Returns the unregister function.
 */
export function registerSignOutCleanup(cleanup: SignOutCleanup): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/** Session storage keys the access feature writes (sign-in flow, interruption notices). */
export const ACCESS_SESSION_STORAGE_PREFIX = "symplist.access.";

let state: SignOutState = { kind: "idle" };
const listeners = new Set<() => void>();

function setState(next: SignOutState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

export function getSignOutState(): SignOutState {
  return state;
}

export function subscribeSignOutState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The api accepted an account deletion: the session is gone and the page is leaving. Gates stop
 * redirecting on their own while this is set, so the deletion's own navigation is the only one.
 */
export function beginAccountDeletionExit(): void {
  setState({ kind: "signing_out", reason: "account_deleted" });
}

/** Returns the state to idle: a dismissed failure, or a page restored from the back-forward cache. */
export function resetSignOutState(): void {
  setState({ kind: "idle" });
}

/** Test support: returns the sign-out state to idle and forgets registered cleanups. */
export function resetSignOutForTests(): void {
  cleanups.clear();
  setState({ kind: "idle" });
}

export interface SignOutDependencies {
  readonly api: Pick<AccessApi, "logout">;
  /** Drops the browser client's cached CSRF token. */
  readonly clearCsrfToken: () => void;
  /** Marks the in-memory session signed out so no gate renders protected content again. */
  readonly markSignedOut: () => void;
  /** Full document navigation to sign-in (§15), so nothing protected stays in memory. */
  readonly assign: (href: string) => void;
  readonly storages?: () => readonly Storage[];
}

function browserStorages(): readonly Storage[] {
  if (typeof window === "undefined") return [];
  const result: Storage[] = [];
  for (const read of [() => window.sessionStorage, () => window.localStorage]) {
    try {
      result.push(read());
    } catch {
      // Site data can be blocked; there is nothing to clean then.
    }
  }
  return result;
}

function removeAccessKeys(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(ACCESS_SESSION_STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/**
 * Clears everything the browser keeps for the signed-in person (§5.1): the appearance cookie, the
 * analytics identity (`logout()` removes PostHog's stored identity even when this page never loaded
 * it), feature cleanups, the CSRF token and the access feature's session storage.
 */
export async function clearBrowserSessionState(
  dependencies: Pick<SignOutDependencies, "clearCsrfToken" | "storages">,
): Promise<void> {
  for (const cleanup of [...cleanups]) {
    try {
      await cleanup();
    } catch {
      // One feature's cleanup failing never keeps the person signed in.
    }
  }
  try {
    resetAppearanceForSignOut();
  } catch {
    // Without a document there is no cookie to remove.
  }
  try {
    await createBrowserAnalytics({ enabled: false, projectKey: undefined }).logout();
  } catch {
    // Analytics failures never block sign-out (§15).
  }
  dependencies.clearCsrfToken();
  for (const storage of (dependencies.storages ?? browserStorages)()) {
    try {
      removeAccessKeys(storage);
    } catch {
      // Ignore storages that refuse access.
    }
  }
}

/**
 * Signs out (§5.1): ends this session at the api, then clears the browser's state and loads the email
 * entry as a new document. A session that had already ended counts as signed out. When the api cannot
 * be reached the person stays signed in and the state reports the failure, so nothing claims a
 * sign-out that did not happen.
 */
export async function signOut(
  dependencies: SignOutDependencies,
): Promise<"signed_out" | "failed" | "in_progress"> {
  if (state.kind === "signing_out") return "in_progress";
  setState({ kind: "signing_out", reason: "sign_out" });
  try {
    await dependencies.api.logout();
  } catch (error) {
    const problem = problemOf(error);
    if (problem.kind !== "session_expired") {
      setState({ kind: "failed", reason: problem.kind === "network" ? "network" : "unexpected" });
      return "failed";
    }
  }
  await clearBrowserSessionState(dependencies);
  dependencies.markSignedOut();
  // The state stays `signing_out` while the document unloads, so no gate starts its own redirect.
  dependencies.assign(SIGN_IN_PATH);
  return "signed_out";
}
