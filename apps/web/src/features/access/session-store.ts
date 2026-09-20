import type { AccessDestination, AccessState, MeResponse } from "@symplist/contracts";
import type { AccessApi } from "./api.ts";
import { problemOf } from "./errors.ts";

/** Whether the session is known yet (§5.1). Mirrors the seam's `SessionStatus`. */
export type SessionPhase = "loading" | "signed_out" | "signed_in";

/** Why the latest identity read produced no answer. */
export type SessionLoadError = "network" | "unexpected";

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  /** The latest `GET /v1/me` body while signed in. */
  readonly me: MeResponse | null;
  /**
   * The latest read failed without an answer. Before the first answer the phase stays `loading`, so
   * gates show a retryable failure instead of guessing; afterwards the known state is kept.
   */
  readonly loadError: SessionLoadError | null;
  /** The session ended while this page was signed in (a 401 after sign-in, or socket close 4401). */
  readonly expired: boolean;
  /** Increments whenever the account's access state or destination changes while signed in. */
  readonly accessRevision: number;
}

const initialSnapshot: SessionSnapshot = {
  phase: "loading",
  me: null,
  loadError: null,
  expired: false,
  accessRevision: 0,
};

/**
 * The account's destination computed from its access fields, as the api does (`accessDestination`,
 * §5.4). Used only for fixed preview sessions; live sessions use the api's `destination`.
 */
export function destinationFor(access: AccessState, betaAccessRequired = true): AccessDestination {
  if (access.deletionState !== "none") return "beta_gate";
  if (access.emailVerifiedAt === null) return "beta_gate";
  if (access.suspendedAt !== null || access.betaState === "relocked") return "paused";
  const unlocked = access.betaState === "unlocked" || !betaAccessRequired;
  if (!unlocked) return "beta_gate";
  return access.onboardingStep === "done" ? "app" : "onboarding";
}

function sameAccess(a: MeResponse | null, b: MeResponse | null): boolean {
  if (!a || !b) return a === b;
  if (a.destination !== b.destination || a.user.role !== b.user.role) return false;
  const left = a.access;
  const right = b.access;
  return (
    left.accessGeneration === right.accessGeneration &&
    left.betaState === right.betaState &&
    left.suspendedAt === right.suspendedAt &&
    left.onboardingStep === right.onboardingStep &&
    left.role === right.role &&
    left.deletionState === right.deletionState &&
    left.emailVerifiedAt === right.emailVerifiedAt
  );
}

/**
 * The signed-in identity for the whole document (§5.1): one `GET /v1/me` read shared by every gate,
 * replaced by the bodies of calls that change the caller's own access (verify, redeem, name,
 * onboarding) and refreshed when the realtime socket reports `access.changed`. Concurrent refreshes
 * share one request.
 */
export class SessionStore {
  private snapshot: SessionSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private inflight: Promise<SessionSnapshot> | null = null;
  private started = false;
  private lastLoadedAt = 0;

  constructor(
    private readonly api: Pick<AccessApi, "me">,
    private readonly now: () => number = Date.now,
  ) {}

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Loads the identity once; later calls are no-ops. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
  }

  /** Milliseconds since the last answer from the api, or Infinity before the first one. */
  ageMs(): number {
    return this.lastLoadedAt === 0 ? Number.POSITIVE_INFINITY : this.now() - this.lastLoadedAt;
  }

  /** Reads `GET /v1/me` again; resolves with the resulting snapshot and never rejects. */
  refresh(): Promise<SessionSnapshot> {
    this.started = true;
    if (this.inflight) return this.inflight;
    const request = this.load().finally(() => {
      if (this.inflight === request) this.inflight = null;
    });
    this.inflight = request;
    return request;
  }

  /** Applies an identity the api just returned (verification, redemption, name, onboarding). */
  setMe(me: MeResponse): void {
    this.started = true;
    this.lastLoadedAt = this.now();
    const moved = this.snapshot.phase === "signed_in" && !sameAccess(this.snapshot.me, me);
    this.update({
      phase: "signed_in",
      me,
      loadError: null,
      expired: false,
      accessRevision: this.snapshot.accessRevision + (moved ? 1 : 0),
    });
  }

  /** The session ended: after sign-out (`expired: false`) or because the api ended it. */
  markSignedOut(options: { readonly expired: boolean }): void {
    this.started = true;
    this.update({
      phase: "signed_out",
      me: null,
      loadError: null,
      expired: options.expired && this.snapshot.phase === "signed_in",
      accessRevision: this.snapshot.accessRevision,
    });
  }

  private async load(): Promise<SessionSnapshot> {
    try {
      const me = await this.api.me();
      this.setMe(me);
    } catch (error) {
      const problem = problemOf(error);
      if (problem.kind === "session_expired") {
        this.lastLoadedAt = this.now();
        this.markSignedOut({ expired: true });
      } else if (problem.kind !== "aborted") {
        this.update({
          ...this.snapshot,
          loadError: problem.kind === "network" ? "network" : "unexpected",
        });
      }
    }
    return this.snapshot;
  }

  private update(next: SessionSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
