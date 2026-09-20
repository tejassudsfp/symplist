import { AsyncLocalStorage } from "node:async_hooks";
import { PostHog, type PostHogOptions } from "posthog-node";
import { checkOutgoingEvent, posthogUsAppHost, posthogUsIngestHost } from "./config.ts";
import {
  type AnalyticsEventName,
  type AnalyticsEventOwner,
  type AnalyticsEventProperties,
  type AnalyticsValidationFailure,
  type ClientAnalyticsEventName,
  type ServerAnalyticsEventName,
  validateAnalyticsEvent,
} from "./events.ts";
import { scrubEvent } from "./scrub.ts";

export type { AnalyticsEventProperties, ServerAnalyticsEventName } from "./events.ts";

/**
 * Server analytics emitter (§15): one `posthog-node` client per process with `disableGeoip: true`,
 * the same allowlist as the client, and a stored-consent check before every capture. The api uses
 * bounded batched capture and flushes on shutdown; the worker sends each event immediately within a
 * time bound. Analytics failures never block writes: capture never throws.
 */

/** The account's stored analytics state, read from D1 in the same request (§15, decision R9). */
export interface AnalyticsSubject {
  readonly consent: "unset" | "granted" | "denied";
  /** `users.analytics_id`: random, never derived from identity, never logged. */
  readonly analyticsId: string | null;
}

export type ServerAnalyticsDelivery = "batched" | "immediate";

/** A redacted emitter log entry: codes and counts only, never ids, properties or keys. */
export interface ServerAnalyticsLogEntry {
  readonly event:
    | "analytics.capture_failed"
    | "analytics.flush_failed"
    | "analytics.provider_error";
  readonly code: string;
}

export interface ServerAnalyticsOptions {
  /** `ANALYTICS_ENABLED`. */
  readonly enabled: boolean;
  /** `POSTHOG_PROJECT_KEY`. Without it the emitter is a no-op. */
  readonly projectKey: string | undefined;
  /** `POSTHOG_HOST`; defaults to PostHog US cloud ingestion. */
  readonly host?: string;
  /** `batched` for the long-running api, `immediate` for Trigger tasks (§15). */
  readonly delivery: ServerAnalyticsDelivery;
  /** Injected transport, for tests. */
  readonly fetch?: PostHogOptions["fetch"];
  readonly logger?: { warn(entry: ServerAnalyticsLogEntry): void };
  /** Upper bound on one immediate capture; defaults to 3 seconds. */
  readonly immediateTimeoutMs?: number;
  /** Bounded in-memory queue for batched delivery; defaults to 1000 events. */
  readonly maxQueueSize?: number;
  readonly flushAt?: number;
  readonly flushIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  /** Retries per batch request; defaults to 2. */
  readonly fetchRetryCount?: number;
  /** Delay between batch retries; defaults to 1 second. */
  readonly fetchRetryDelayMs?: number;
  /** Upper bound on the final flush; defaults to 5 seconds. */
  readonly shutdownTimeoutMs?: number;
}

export type ServerCaptureOutcome =
  | { readonly status: "queued" }
  | { readonly status: "sent" }
  | {
      readonly status: "skipped";
      readonly reason: "disabled" | "consent_not_granted" | "missing_identity" | "shut_down";
    }
  | {
      readonly status: "rejected";
      readonly reason: AnalyticsValidationFailure | "invalid_event_id";
    }
  | { readonly status: "failed"; readonly reason: "timeout" | "provider_error" };

export interface ServerCaptureInput<Name extends ServerAnalyticsEventName> {
  readonly subject: AnalyticsSubject;
  readonly event: Name;
  readonly properties: AnalyticsEventProperties<Name>;
  /** A UUID for deduplication, derived from the confirmed action (for example its request id). */
  readonly eventId: string;
}

export interface ServerAnalyticsEmitter {
  /** Whether events can be sent at all (`ANALYTICS_ENABLED` and a project key). */
  readonly enabled: boolean;
  capture<Name extends ServerAnalyticsEventName>(
    input: ServerCaptureInput<Name>,
  ): Promise<ServerCaptureOutcome>;
  /** First-party relay only: the browser owns the action, the server keeps its identity private. */
  captureClient?<Name extends ClientAnalyticsEventName>(input: {
    readonly subject: AnalyticsSubject;
    readonly event: Name;
    readonly properties: AnalyticsEventProperties<Name>;
    readonly eventId: string;
  }): Promise<ServerCaptureOutcome>;
  /** Sends queued events; for per-run cleanup in short-lived processes. Never throws. */
  flush(): Promise<void>;
  /** Flushes and stops the client once, before the process exits. Never throws. */
  shutdown(): Promise<void>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `$`-prefixed events posthog-node may emit on its own; none are allowed through. */
const noSdkEvents: ReadonlySet<string> = new Set();

function checkHttpsOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "") {
    throw new Error(`${label} must be an https origin`);
  }
  return url.origin;
}

class TimeoutSignal extends Error {
  override readonly name = "AnalyticsTimeout";
}

/**
 * The state of one immediate capture. posthog-node reports a failed immediate send only by emitting
 * `error` on the client it shares with every other capture, and the error carries nothing that names
 * the event, so the emitter attributes it through the async context the send runs in.
 */
interface ImmediateCaptureScope {
  providerFailed: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal("analytics timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createServerAnalytics(options: ServerAnalyticsOptions): ServerAnalyticsEmitter {
  const projectKey = options.projectKey?.trim();
  const enabled = options.enabled && projectKey !== undefined && projectKey !== "";
  const warn = (entry: ServerAnalyticsLogEntry) => {
    try {
      options.logger?.warn(entry);
    } catch {
      // A failing logger must not break capture.
    }
  };

  if (!enabled) {
    return {
      enabled: false,
      capture: async () => ({ status: "skipped", reason: "disabled" }),
      captureClient: async () => ({ status: "skipped", reason: "disabled" }),
      flush: async () => undefined,
      shutdown: async () => undefined,
    };
  }

  const maxQueueSize = Math.max(1, options.maxQueueSize ?? 1000);
  const client = new PostHog(projectKey, {
    host: checkHttpsOrigin(options.host ?? posthogUsIngestHost, "POSTHOG_HOST"),
    disableGeoip: true,
    enableExceptionAutocapture: false,
    disableRemoteConfig: true,
    preloadFeatureFlags: false,
    sendFeatureFlagEvent: false,
    persistence: "memory",
    // posthog-node raises the queue bound to flushAt, so flushAt never exceeds the bound.
    flushAt: options.delivery === "immediate" ? 1 : Math.min(options.flushAt ?? 20, maxQueueSize),
    flushInterval: options.delivery === "immediate" ? 0 : (options.flushIntervalMs ?? 5000),
    maxQueueSize,
    requestTimeout: options.requestTimeoutMs ?? 5000,
    fetchRetryCount: options.fetchRetryCount ?? 2,
    fetchRetryDelay: options.fetchRetryDelayMs ?? 1000,
    before_send: (event) => {
      if (event === null) return null;
      const scrubbed = scrubEvent(event);
      return checkOutgoingEvent("server", scrubbed, noSdkEvents) ||
        checkOutgoingEvent("client", scrubbed, noSdkEvents)
        ? scrubbed
        : null;
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // One listener for the life of the client. posthog-node emits `error` synchronously inside the
  // failing send, and each immediate capture runs its send inside its own async context, so the
  // failure is recorded only on the capture that caused it; concurrent captures never observe each
  // other's errors. Errors outside any capture (batched background flushes) are logged here.
  const immediateCaptures = new AsyncLocalStorage<ImmediateCaptureScope>();
  client.on("error", () => {
    const scope = immediateCaptures.getStore();
    if (scope !== undefined) {
      scope.providerFailed = true;
      return;
    }
    warn({ event: "analytics.provider_error", code: "analytics.provider_error" });
  });

  let stopped = false;

  const capture = async (
    owner: AnalyticsEventOwner,
    input: {
      readonly subject: AnalyticsSubject;
      readonly event: AnalyticsEventName;
      readonly properties: unknown;
      readonly eventId: string;
    },
  ): Promise<ServerCaptureOutcome> => {
    if (stopped) return { status: "skipped", reason: "shut_down" };
    if (input.subject.consent !== "granted") {
      return { status: "skipped", reason: "consent_not_granted" };
    }
    const distinctId = input.subject.analyticsId;
    if (distinctId === null || distinctId.trim() === "") {
      return { status: "skipped", reason: "missing_identity" };
    }
    if (!uuidPattern.test(input.eventId)) return { status: "rejected", reason: "invalid_event_id" };
    const validation = validateAnalyticsEvent(owner, input.event, input.properties);
    if (!validation.ok) return { status: "rejected", reason: validation.reason };

    const message = {
      distinctId,
      event: validation.event,
      properties: { ...validation.properties },
      uuid: input.eventId.toLowerCase(),
      disableGeoip: true,
    };
    try {
      if (options.delivery === "batched") {
        client.capture(message);
        return { status: "queued" };
      }
      // posthog-node reports HTTP failures of an immediate send through its error event, which the
      // client-wide listener records on this capture's scope only.
      const scope: ImmediateCaptureScope = { providerFailed: false };
      await withTimeout(
        immediateCaptures.run(scope, () => client.captureImmediate(message)),
        options.immediateTimeoutMs ?? 3000,
      );
      if (!scope.providerFailed) return { status: "sent" };
      warn({ event: "analytics.capture_failed", code: "analytics.provider_error" });
      return { status: "failed", reason: "provider_error" };
    } catch (error) {
      const timedOut = error instanceof TimeoutSignal;
      warn({
        event: "analytics.capture_failed",
        code: timedOut ? "analytics.timeout" : "analytics.provider_error",
      });
      return { status: "failed", reason: timedOut ? "timeout" : "provider_error" };
    }
  };

  return {
    enabled: true,
    capture: (input) => capture("server", input),
    captureClient: (input) => capture("client", input),

    async flush() {
      try {
        await withTimeout(client.flush(), options.shutdownTimeoutMs ?? 5000);
      } catch {
        warn({ event: "analytics.flush_failed", code: "analytics.flush_failed" });
      }
    },

    async shutdown() {
      if (stopped) return;
      stopped = true;
      try {
        await client.shutdown(options.shutdownTimeoutMs ?? 5000);
      } catch {
        warn({ event: "analytics.flush_failed", code: "analytics.shutdown_failed" });
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Account deletion (§5.6)                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export type PostHogFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PostHogPersonDeletionOptions {
  /** `POSTHOG_PERSONAL_API_KEY` (api only; scopes `person:write` and `person:read`). */
  readonly personalApiKey: string;
  /** `POSTHOG_PROJECT_ID`. */
  readonly projectId: string;
  /** Defaults to PostHog US cloud (`https://us.posthog.com`). */
  readonly appHost?: string;
  readonly fetch?: PostHogFetch;
  /** Per-request timeout; defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

export type PostHogDeletionErrorCode =
  | "analytics.deletion_unauthorized"
  | "analytics.deletion_rate_limited"
  | "analytics.deletion_unavailable"
  | "analytics.deletion_rejected"
  | "analytics.deletion_network_error"
  | "analytics.deletion_invalid_response";

/** A PostHog REST failure. Carries status and code only, never the analytics id or the key. */
export class PostHogDeletionError extends Error {
  override readonly name = "PostHogDeletionError";
  readonly code: PostHogDeletionErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: PostHogDeletionErrorCode,
    details: { status?: number; retryable: boolean; retryAfterSeconds?: number },
  ) {
    super(`PostHog person deletion request failed (${code})`);
    this.code = code;
    this.status = details.status;
    this.retryable = details.retryable;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/** The recorded 202 from `persons/bulk_delete/`. */
export interface PostHogDeletionRequestResult {
  readonly status: 202;
  readonly personsFound: number;
  readonly personsDeleted: number;
  readonly eventsQueuedForDeletion: boolean;
  readonly recordingsQueuedForDeletion: boolean;
  /**
   * The person UUIDs behind the analytics id, looked up just before the delete. `deletion_status` is
   * keyed by person UUID and the persons are gone after `bulk_delete`, so the caller records these
   * to poll `eventDeletionStatus` until every one reports `completed`.
   */
  readonly personUuids: readonly string[];
  /** Person UUIDs PostHog could not delete. */
  readonly failedPersonUuids: readonly string[];
}

export type PostHogEventDeletionStatus = "pending" | "completed" | "not_found";

export interface PostHogPersonDeletionClient {
  /** The PostHog person UUIDs behind an analytics id, for polling deletion status. */
  findPersonUuids(analyticsId: string): Promise<readonly string[]>;
  /**
   * Looks up the person UUIDs, then deletes the person with its events and recordings (§5.6). Safe
   * to repeat: a second call finds no persons and PostHog queues nothing new.
   */
  requestDeletion(analyticsId: string): Promise<PostHogDeletionRequestResult>;
  /** Event deletion status for one person UUID, polled by the api reconciler. */
  eventDeletionStatus(personUuid: string): Promise<PostHogEventDeletionStatus>;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PostHog person deletion through the private REST API with the personal key injected (§5.6,
 * research D2): `POST /api/projects/<id>/persons/bulk_delete/` with `distinct_ids`,
 * `delete_events: true` and `delete_recordings: true`.
 */
export function createPostHogPersonDeletionClient(
  options: PostHogPersonDeletionOptions,
): PostHogPersonDeletionClient {
  if (options.personalApiKey.trim() === "") throw new Error("POSTHOG_PERSONAL_API_KEY is required");
  if (!/^\d+$/.test(options.projectId)) throw new Error("POSTHOG_PROJECT_ID must be numeric");
  const appHost = checkHttpsOrigin(options.appHost ?? posthogUsAppHost, "PostHog app host");
  const fetchImpl: PostHogFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = `${appHost}/api/projects/${options.projectId}/persons`;

  const request = async (url: string, init: RequestInit, expected: number): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${options.personalApiKey}`,
          Accept: "application/json",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PostHogDeletionError("analytics.deletion_network_error", { retryable: true });
    }
    if (response.status !== expected) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
      const details = {
        status: response.status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
      if (response.status === 401 || response.status === 403) {
        throw new PostHogDeletionError("analytics.deletion_unauthorized", {
          ...details,
          retryable: false,
        });
      }
      if (response.status === 429) {
        throw new PostHogDeletionError("analytics.deletion_rate_limited", {
          ...details,
          retryable: true,
        });
      }
      if (response.status >= 500) {
        throw new PostHogDeletionError("analytics.deletion_unavailable", {
          ...details,
          retryable: true,
        });
      }
      throw new PostHogDeletionError("analytics.deletion_rejected", {
        ...details,
        retryable: false,
      });
    }
    try {
      return await response.json();
    } catch {
      throw new PostHogDeletionError("analytics.deletion_invalid_response", {
        status: response.status,
        retryable: true,
      });
    }
  };

  const invalid = (status: number) =>
    new PostHogDeletionError("analytics.deletion_invalid_response", { status, retryable: true });

  const findPersonUuids = async (analyticsId: string): Promise<readonly string[]> => {
    if (analyticsId.trim() === "") {
      throw new PostHogDeletionError("analytics.deletion_rejected", { retryable: false });
    }
    const url = `${base}/?distinct_id=${encodeURIComponent(analyticsId)}`;
    const body = await request(url, { method: "GET" }, 200);
    if (!isRecord(body) || !Array.isArray(body.results)) throw invalid(200);
    return body.results.flatMap((person) =>
      isRecord(person) && typeof person.uuid === "string" && uuidPattern.test(person.uuid)
        ? [person.uuid]
        : [],
    );
  };

  return {
    findPersonUuids,

    async requestDeletion(analyticsId) {
      const personUuids = await findPersonUuids(analyticsId);
      const body = await request(
        `${base}/bulk_delete/`,
        {
          method: "POST",
          body: JSON.stringify({
            distinct_ids: [analyticsId],
            delete_events: true,
            delete_recordings: true,
          }),
        },
        202,
      );
      if (
        !isRecord(body) ||
        typeof body.persons_found !== "number" ||
        typeof body.persons_deleted !== "number" ||
        typeof body.events_queued_for_deletion !== "boolean" ||
        typeof body.recordings_queued_for_deletion !== "boolean"
      ) {
        throw invalid(202);
      }
      const errors = Array.isArray(body.deletion_errors) ? body.deletion_errors : [];
      return {
        status: 202,
        personsFound: body.persons_found,
        personsDeleted: body.persons_deleted,
        eventsQueuedForDeletion: body.events_queued_for_deletion,
        recordingsQueuedForDeletion: body.recordings_queued_for_deletion,
        personUuids,
        failedPersonUuids: errors.flatMap((entry) =>
          isRecord(entry) && typeof entry.person_uuid === "string" ? [entry.person_uuid] : [],
        ),
      };
    },

    async eventDeletionStatus(personUuid) {
      if (!uuidPattern.test(personUuid)) {
        throw new PostHogDeletionError("analytics.deletion_rejected", { retryable: false });
      }
      const url = `${base}/deletion_status/?person_uuid=${encodeURIComponent(personUuid)}&status=all`;
      const body = await request(url, { method: "GET" }, 200);
      if (!isRecord(body) || !Array.isArray(body.results)) throw invalid(200);
      const rows = body.results.filter(
        (row): row is Record<string, unknown> => isRecord(row) && row.person_uuid === personUuid,
      );
      if (rows.length === 0) return "not_found";
      return rows.every((row) => row.status === "completed" || row.delete_verified_at != null)
        ? "completed"
        : "pending";
    },
  };
}
