/**
 * The cloud session's lifetime in the main process: restore it on launch, persist it when the api creates
 * one, and clear it the moment the api says it is gone.
 *
 * The renderer runs the web app's own sign-in screens unchanged — `apps/web/src/features/access/signin`
 * over `useAccessApi()` — so nothing here knows about email codes or beta invites. It watches the traffic
 * those screens produce instead, which means the desktop cannot drift out of step with a sign-in flow it
 * does not reimplement. Three observations do all the work:
 *
 *   - `POST /v1/auth/otp/verify` answering 200 is a new session. The api has just sent `Set-Cookie`; the
 *     jar has it; it goes to the keychain.
 *   - `POST /v1/auth/logout` is about to be sent. Anything the session authorizes releasing is released
 *     first, while it still can be, and the session is dropped when the api confirms.
 *   - any answer of `auth.session_required` means the cookie resolves to nothing at the api
 *     (`AccessGuard`). That one code is authoritative: the jar and the encrypted blob go immediately, so
 *     a restart does not retry a dead token, and the renderer is told so it can route to sign-in.
 *
 * A network failure clears nothing. "The api could not be reached" and "the api rejected this session"
 * look nothing alike here, and conflating them would sign people out every time their wifi dropped.
 *
 * Sessions have a 30-day absolute lifetime that activity never extends (`SESSION_LIFETIME_MS` in
 * `packages/core/src/access/sessions.ts`), and there is no refresh token anywhere in the design. A
 * desktop user therefore re-enters an email code at least monthly. That is the api's design showing
 * through, not something this module can paper over.
 */
import type { MainLog } from "../log.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type { CookieJar, StoredCookie } from "./cookie-jar.ts";
import type { CloudHttp, CloudResponse } from "./http.ts";

/** The secret store entry holding the session cookie. */
export const SESSION_SECRET_NAME = "cloud-session";

/**
 * The stored shape. `version` lets a later change discard rather than misread; `apiOrigin` makes a blob
 * from a different cloud unusable instead of a mystery 401 loop.
 */
export const SESSION_BLOB_VERSION = 1;

export interface PersistedSession {
  readonly version: number;
  readonly apiOrigin: string;
  readonly cookieName: string;
  readonly cookieValue: string;
  /** Epoch milliseconds, or null when the cookie carried no expiry. */
  readonly expiresAt: number | null;
}

/**
 * The default bound on the launch confirmation. Generous enough for a slow network and short enough that
 * nobody watches a blank window wondering whether the app started.
 */
const DEFAULT_RESTORE_TIMEOUT_MS = 8_000;

/** The api's answer to `auth.session_required`: this session resolves to nothing. */
export const SESSION_REQUIRED_CODE = "auth.session_required";

/** What main learns about the account from a `MeResponse`, and nothing more. */
export interface IdentitySnapshot {
  /** `app`, `onboarding`, `beta_gate` or `paused` (§5.4). Which screen the web app routes to. */
  readonly destination: string;
  readonly accessGeneration: number;
}

/**
 * Device credentials whose lifetime follows the session. The MCP grant key dsh authenticates with is
 * the one that exists today, and the model provider key may join it.
 *
 * It is a hook rather than a direct call because the ordering is the part that matters and belongs here:
 * a grant survives session revocation (the mcp session-revoke contributor only expires pending
 * `oauth_requests`), so it must be revoked *before* the logout that would take away the authority to
 * revoke it.
 */
export interface SessionCredentialHooks {
  /** A live session, at a known access level. Provision what needs one; must not throw. */
  established(identity: IdentitySnapshot): Promise<void>;
  /** A sign-out is about to be sent. Release server-side credentials now; must not throw. */
  beforeSignOut(): Promise<void>;
  /** The session is gone. Drop local copies whatever happened on the server; must not throw. */
  cleared(): Promise<void>;
}

/** Hooks that do nothing, for a shell with no device credentials yet. */
export const noCredentialHooks: SessionCredentialHooks = Object.freeze({
  established: async () => undefined,
  beforeSignOut: async () => undefined,
  cleared: async () => undefined,
});

/** How a restore attempt ended. */
export type RestoreOutcome =
  /** A stored session answered `GET /v1/me`: the app opens signed in. */
  | "restored"
  /** Nothing stored, or what was stored is dead and has been removed. */
  | "signed_out"
  /** Something is stored and the api could not be reached, so it was kept untouched. */
  | "unreachable";

export interface CloudSessionOptions {
  readonly apiOrigin: string;
  readonly jar: CookieJar;
  readonly store: SecretStore;
  readonly http: CloudHttp;
  readonly log: MainLog;
  /** Told when the session ended without the renderer asking, so it can route to sign-in. */
  readonly onSessionEnded: () => void;
  /**
   * The session became established. Symmetric with `onSessionEnded`, and added for the renderer's
   * `sym_hint`: the proxy redirects on that cookie's absence, so something has to say when a user
   * is signed in, not only when they stop being.
   */
  readonly onSessionStarted?: () => void;
  readonly credentials?: SessionCredentialHooks;
  readonly now?: () => number;
  /**
   * How long the launch confirmation may take. The window is created after `restore()` resolves, so an
   * unreachable api must not be able to hold the app on a blank screen for an OS-length connect timeout.
   */
  readonly restoreTimeoutMs?: number;
}

/** Parses a stored blob. Returns null for anything that is not a usable session for this cloud. */
export function parsePersistedSession(
  raw: string,
  apiOrigin: string,
  now: number,
): PersistedSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const expiresAt = record.expiresAt;
  if (record.version !== SESSION_BLOB_VERSION) return null;
  if (record.apiOrigin !== apiOrigin) return null;
  if (typeof record.cookieName !== "string" || record.cookieName.length === 0) return null;
  if (typeof record.cookieValue !== "string" || record.cookieValue.length === 0) return null;
  if (expiresAt !== null && typeof expiresAt !== "number") return null;
  if (typeof expiresAt === "number" && (!Number.isFinite(expiresAt) || expiresAt <= now))
    return null;
  return {
    version: SESSION_BLOB_VERSION,
    apiOrigin,
    cookieName: record.cookieName,
    cookieValue: record.cookieValue,
    expiresAt: typeof expiresAt === "number" ? expiresAt : null,
  };
}

/** The error code of an api error envelope, or null when the body is not one. */
export function errorCodeOf(body: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const error = (value as { error?: unknown } | null)?.error;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : null;
}

type MeShape = { destination?: unknown; access?: { accessGeneration?: unknown } };

function snapshotOf(record: MeShape | null | undefined): IdentitySnapshot | null {
  const generation = record?.access?.accessGeneration;
  if (typeof record?.destination !== "string" || typeof generation !== "number") return null;
  return { destination: record.destination, accessGeneration: generation };
}

/**
 * The parts of a `MeResponse` main reads, or null when the body is not one.
 *
 * Some routes return the identity nested under `me` rather than as the whole body, and one of them is the
 * one that matters most here: `POST /v1/access/redeem` answers `{ outcome, me }`, and beta unlock is the
 * exact moment an account becomes admitted and can hold an MCP grant. Reading only the top level would
 * put off provisioning until the next `GET /v1/me`, which could be a page refresh away.
 */
export function identityOf(body: string): IdentitySnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const record = value as (MeShape & { me?: MeShape }) | null;
  return snapshotOf(record) ?? snapshotOf(record?.me);
}

/** Whether an account at this destination may hold device credentials: it is past the beta gate. */
export function isAdmitted(identity: IdentitySnapshot): boolean {
  return identity.destination === "app" || identity.destination === "onboarding";
}

function isSignOutRequest(method: string, path: string): boolean {
  return method === "POST" && pathnameOf(path) === "/v1/auth/logout";
}

function isVerifyRequest(method: string, path: string): boolean {
  return method === "POST" && pathnameOf(path) === "/v1/auth/otp/verify";
}

function pathnameOf(path: string): string {
  const query = path.indexOf("?");
  return query < 0 ? path : path.slice(0, query);
}

/**
 * The session. Constructed in `start()` after `app.whenReady()` — the secret store cannot answer before
 * that — and consulted by the cloud IPC handler around every request.
 */
export class CloudSession {
  private readonly options: CloudSessionOptions;
  private readonly credentials: SessionCredentialHooks;
  private readonly now: () => number;
  private identity: IdentitySnapshot | null = null;
  private signedIn = false;

  constructor(options: CloudSessionOptions) {
    this.options = options;
    this.credentials = options.credentials ?? noCredentialHooks;
    this.now = options.now ?? Date.now;
  }

  /** The account's destination as of the last answer, for the window to open on the right screen. */
  currentIdentity(): IdentitySnapshot | null {
    return this.identity;
  }

  /**
   * Restores a stored session and confirms it is still live with one `GET /v1/me`. Called once, before
   * the window loads, so the frontend's first render is already right.
   */
  async restore(): Promise<RestoreOutcome> {
    const raw = this.options.store.read(SESSION_SECRET_NAME);
    if (raw === null) return "signed_out";
    const persisted = parsePersistedSession(raw, this.options.apiOrigin, this.now());
    if (!persisted) {
      // A different cloud, a superseded shape, or a cookie that has run out its 30 days. None of these
      // will ever work again, so the blob goes rather than being retried on every launch.
      this.options.log.info("cloud.session_blob_discarded");
      await this.clear({ notifyRenderer: false });
      return "signed_out";
    }
    const cookie: StoredCookie = {
      name: persisted.cookieName,
      value: persisted.cookieValue,
      expiresAt: persisted.expiresAt,
    };
    if (!this.options.jar.restoreSession(cookie)) {
      await this.clear({ notifyRenderer: false });
      return "signed_out";
    }

    let response: CloudResponse;
    try {
      response = await this.options.http({
        method: "GET",
        path: "/v1/me",
        headers: [["Accept", "application/json"]],
        body: null,
        signal: AbortSignal.timeout(this.options.restoreTimeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS),
      });
    } catch {
      // Offline, DNS, a proxy in the way. The session may well be fine; keep it and let the renderer's
      // own `GET /v1/me` report the failure the way the web app already does.
      this.options.log.warn("cloud.restore_unreachable");
      return "unreachable";
    }
    if (response.status === 200) {
      const identity = identityOf(response.body);
      if (identity) await this.markSignedIn(identity);
      this.options.log.info("cloud.session_restored", {
        destination: identity?.destination ?? null,
      });
      return "restored";
    }
    if (errorCodeOf(response.body) === SESSION_REQUIRED_CODE) {
      this.options.log.info("cloud.session_rejected_on_restore");
      await this.clear({ notifyRenderer: false });
      return "signed_out";
    }
    // Any other answer — a rate limit, a 5xx — is not a statement about this session, so it is kept.
    this.options.log.warn("cloud.restore_inconclusive", { status: response.status });
    return "unreachable";
  }

  /**
   * Runs before a request leaves. Its one job is the sign-out ordering: a device credential the session
   * authorizes revoking has to be revoked while the session is still alive.
   */
  async beforeRequest(method: string, path: string): Promise<void> {
    if (!isSignOutRequest(method.toUpperCase(), path)) return;
    await this.safely("credentials.before_sign_out", () => this.credentials.beforeSignOut());
  }

  /**
   * Runs after every answer. Persists a new session, clears a dead one, and keeps the last known
   * destination so device credentials are provisioned as soon as the account is admitted.
   */
  async afterResponse(method: string, path: string, response: CloudResponse): Promise<void> {
    const upper = method.toUpperCase();
    if (response.status === 401 && errorCodeOf(response.body) === SESSION_REQUIRED_CODE) {
      if (this.signedIn || this.options.jar.session() !== null) {
        this.options.log.info("cloud.session_ended_by_api");
        await this.clear({ notifyRenderer: true });
      }
      return;
    }
    if (isSignOutRequest(upper, path) && response.status === 200) {
      this.options.log.info("cloud.signed_out");
      // The renderer asked for this one and is already navigating, so it is not told again.
      await this.clear({ notifyRenderer: false });
      return;
    }
    if (response.status !== 200) return;
    const identity = identityOf(response.body);
    if (!identity) return;
    if (isVerifyRequest(upper, path)) this.persist();
    await this.markSignedIn(identity);
  }

  /**
   * Writes the jar's session cookie to the keychain. Only the session tier can be reached from here —
   * `CookieJar.session()` refuses to return anything else — so the Vault cookie cannot be persisted by
   * mistake, and a restart never leaves a vault silently unlocked.
   */
  persist(): boolean {
    const cookie = this.options.jar.session();
    if (!cookie) return false;
    const blob: PersistedSession = {
      version: SESSION_BLOB_VERSION,
      apiOrigin: this.options.apiOrigin,
      cookieName: cookie.name,
      cookieValue: cookie.value,
      expiresAt: cookie.expiresAt,
    };
    const written = this.options.store.write(SESSION_SECRET_NAME, JSON.stringify(blob));
    if (!written) {
      // `safeStorage` is unavailable on this machine. The session works for this run and will be asked
      // for again on the next launch; a plaintext file is not the alternative.
      this.options.log.warn("cloud.session_not_persisted");
    }
    return written;
  }

  /**
   * Forgets the session: the jar (both tiers), the encrypted blob, and any local device credential. The
   * blob goes even when the removal of the server-side credential failed, because leaving a copy of a key
   * behind on a machine the user believes they signed out of is the worse outcome.
   */
  async clear(options: { readonly notifyRenderer: boolean }): Promise<void> {
    this.signedIn = false;
    this.identity = null;
    this.options.jar.clear();
    this.options.store.clear(SESSION_SECRET_NAME);
    await this.safely("credentials.cleared", () => this.credentials.cleared());
    if (options.notifyRenderer) this.options.onSessionEnded();
  }

  private async markSignedIn(identity: IdentitySnapshot): Promise<void> {
    const moved =
      !this.signedIn ||
      this.identity?.destination !== identity.destination ||
      this.identity?.accessGeneration !== identity.accessGeneration;
    const wasSignedOut = !this.signedIn;
    this.signedIn = true;
    this.identity = identity;
    if (wasSignedOut) this.options.onSessionStarted?.();
    if (!moved) return;
    if (!isAdmitted(identity)) return;
    await this.safely("credentials.established", () => this.credentials.established(identity));
  }

  /**
   * A credential hook must never take the session down with it. A grant that could not be minted is a
   * feature that does not work yet; a sign-in that fails because of it is a broken app.
   */
  private async safely(event: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.options.log.error(event, {
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
