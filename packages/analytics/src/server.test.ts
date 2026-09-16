import { gunzipSync } from "node:zlib";
import type { PostHogOptions } from "posthog-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AnalyticsSubject,
  createPostHogPersonDeletionClient,
  createServerAnalytics,
  PostHogDeletionError,
  type PostHogFetch,
  type ServerAnalyticsLogEntry,
  type ServerAnalyticsOptions,
} from "./server.ts";

type PostHogNodeFetch = NonNullable<PostHogOptions["fetch"]>;

interface BatchRequest {
  readonly url: string;
  readonly events: Array<{
    event: string;
    distinct_id: string;
    uuid: string;
    properties: Record<string, unknown>;
  }>;
}

const analyticsId = "0192f0a0-0000-7000-8000-00000000a11d";
const granted: AnalyticsSubject = { consent: "granted", analyticsId };
const eventId = "0192f0a0-0000-7000-8000-0000000e0001";
const created = { source: "mcp", collection: "unclassified", is_subtask: false } as const;

function decode(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    return body[0] === 0x1f && body[1] === 0x8b
      ? gunzipSync(body).toString("utf8")
      : new TextDecoder().decode(body);
  }
  throw new Error("unexpected body type");
}

function ingestResponse(status: number): Awaited<ReturnType<PostHogNodeFetch>> {
  return {
    status,
    text: async () => "{}",
    json: async () => ({}),
    headers: { get: () => null },
  } as unknown as Awaited<ReturnType<PostHogNodeFetch>>;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeIngest(behaviour: { status?: number; hang?: boolean } = {}) {
  const requests: BatchRequest[] = [];
  const fetch: PostHogNodeFetch = async (url, options) => {
    if (behaviour.hang) return new Promise(() => undefined);
    const payload = JSON.parse(decode(options.body)) as { batch: BatchRequest["events"] };
    requests.push({ url, events: payload.batch });
    return ingestResponse(behaviour.status ?? 200);
  };
  return { fetch, requests };
}

function emitter(overrides: Partial<ServerAnalyticsOptions> & { fetch: PostHogNodeFetch }) {
  const logs: ServerAnalyticsLogEntry[] = [];
  const instance = createServerAnalytics({
    enabled: true,
    projectKey: "phc_fictional_server_key",
    delivery: "batched",
    fetchRetryCount: 0,
    fetchRetryDelayMs: 0,
    logger: { warn: (entry) => logs.push(entry) },
    ...overrides,
  });
  return { instance, logs };
}

beforeEach(() => {
  // posthog-node prints its own flush errors; keep test output quiet.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server analytics emitter (§15)", () => {
  it("relays client-owned allowlisted events without SDK URL/referrer/profile defaults", async () => {
    const { fetch, requests } = fakeIngest();
    const { instance } = emitter({ fetch });
    expect(
      await instance.captureClient?.({
        subject: granted,
        event: "quick_chat_started",
        properties: { entry: "button" },
        eventId,
      }),
    ).toEqual({ status: "queued" });
    await instance.flush();
    await instance.shutdown();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.events).toHaveLength(1);
    const event = requests[0]?.events[0];
    expect(event).toMatchObject({
      event: "quick_chat_started",
      distinct_id: analyticsId,
      uuid: eventId,
    });
    expect(event?.properties).toEqual({
      entry: "button",
      event_version: 1,
      $geoip_disable: true,
      $is_server: true,
      $lib: "posthog-node",
      $lib_version: "5.52.3",
    });
    for (const forbidden of [
      "$current_url",
      "$referrer",
      "$pathname",
      "$set",
      "$initial_referrer",
      "utm_source",
    ])
      expect(JSON.stringify(event)).not.toContain(forbidden);
  });
  it("is a no-op that makes zero requests when disabled or unconfigured", async () => {
    for (const overrides of [{ enabled: false }, { projectKey: undefined }, { projectKey: " " }]) {
      const { fetch, requests } = fakeIngest();
      const { instance } = emitter({ fetch, ...overrides });
      expect(instance.enabled).toBe(false);
      expect(
        await instance.capture({
          subject: granted,
          event: "task_created",
          properties: created,
          eventId,
        }),
      ).toEqual({ status: "skipped", reason: "disabled" });
      await instance.flush();
      await instance.shutdown();
      expect(requests).toEqual([]);
    }
  });

  it("checks stored consent and identity before capturing", async () => {
    const { fetch, requests } = fakeIngest();
    const { instance } = emitter({ fetch });
    for (const consent of ["unset", "denied"] as const) {
      expect(
        await instance.capture({
          subject: { consent, analyticsId },
          event: "task_created",
          properties: created,
          eventId,
        }),
      ).toEqual({ status: "skipped", reason: "consent_not_granted" });
    }
    expect(
      await instance.capture({
        subject: { consent: "granted", analyticsId: null },
        event: "task_created",
        properties: created,
        eventId,
      }),
    ).toEqual({ status: "skipped", reason: "missing_identity" });
    await instance.shutdown();
    expect(requests).toEqual([]);
  });

  it("rejects unknown events, client-owned events, free text and bad event ids", async () => {
    const { fetch, requests } = fakeIngest();
    const { instance } = emitter({ fetch });
    const untyped = instance.capture as (input: unknown) => Promise<unknown>;
    expect(
      await untyped({ subject: granted, event: "page_viewed", properties: {}, eventId }),
    ).toEqual({
      status: "rejected",
      reason: "unknown_event",
    });
    expect(
      await untyped({ subject: granted, event: "search_used", properties: {}, eventId }),
    ).toEqual({ status: "rejected", reason: "wrong_owner" });
    expect(
      await untyped({
        subject: granted,
        event: "task_created",
        properties: { ...created, title: "Refresh my portfolio" },
        eventId,
      }),
    ).toEqual({ status: "rejected", reason: "invalid_properties" });
    expect(
      await instance.capture({
        subject: granted,
        event: "task_created",
        properties: created,
        eventId: "42",
      }),
    ).toEqual({ status: "rejected", reason: "invalid_event_id" });
    await instance.shutdown();
    expect(requests).toEqual([]);
  });

  it("queues batched events and sends only allowlisted properties when flushed", async () => {
    const { fetch, requests } = fakeIngest();
    const { instance } = emitter({ fetch, flushAt: 50, flushIntervalMs: 60_000 });

    expect(
      await instance.capture({
        subject: granted,
        event: "task_created",
        properties: created,
        eventId,
      }),
    ).toEqual({ status: "queued" });
    expect(requests).toEqual([]);

    await instance.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://us.i.posthog.com/batch/");
    const [event] = requests[0]?.events ?? [];
    expect(event?.event).toBe("task_created");
    expect(event?.distinct_id).toBe(analyticsId);
    expect(event?.uuid).toBe(eventId);
    const own = Object.fromEntries(
      Object.entries(event?.properties ?? {}).filter(([name]) => !name.startsWith("$")),
    );
    expect(own).toEqual({ ...created, event_version: 1 });
    expect(event?.properties.$geoip_disable).toBe(true);
    expect(JSON.stringify(event)).not.toMatch(/\$current_url|\$referrer|\$host|utm_/);
    await instance.shutdown();
  });

  it("flushes queued events on shutdown and refuses captures afterwards", async () => {
    const { fetch, requests } = fakeIngest();
    const { instance } = emitter({ fetch, flushAt: 50, flushIntervalMs: 60_000 });
    await instance.capture({
      subject: granted,
      event: "quick_chat_saved",
      properties: { collection: "later" },
      eventId,
    });
    await instance.shutdown();
    expect(requests.flatMap((request) => request.events).map((event) => event.event)).toEqual([
      "quick_chat_saved",
    ]);
    expect(
      await instance.capture({
        subject: granted,
        event: "task_created",
        properties: created,
        eventId,
      }),
    ).toEqual({ status: "skipped", reason: "shut_down" });
    await instance.shutdown();
  });

  it("sends immediately in worker mode", async () => {
    const { fetch, requests } = fakeIngest();
    const { instance } = emitter({ fetch, delivery: "immediate" });
    expect(
      await instance.capture({
        subject: granted,
        event: "reminder_created",
        properties: {
          channels: "email",
          timing: "previous_day",
          deadline: "date",
          source: "simon",
        },
        eventId,
      }),
    ).toEqual({ status: "sent" });
    expect(requests).toHaveLength(1);
    await instance.shutdown();
  });

  it("never throws or blocks on provider failures, and logs codes only", async () => {
    const failing = fakeIngest({ status: 500 });
    const failed = emitter({ fetch: failing.fetch, delivery: "immediate" });
    expect(
      await failed.instance.capture({
        subject: granted,
        event: "task_created",
        properties: created,
        eventId,
      }),
    ).toEqual({ status: "failed", reason: "provider_error" });
    expect(failed.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed.logs)).not.toContain(analyticsId);
    await failed.instance.shutdown();

    const hanging = fakeIngest({ hang: true });
    const slow = emitter({ fetch: hanging.fetch, delivery: "immediate", immediateTimeoutMs: 20 });
    const started = Date.now();
    expect(
      await slow.instance.capture({
        subject: granted,
        event: "task_created",
        properties: created,
        eventId,
      }),
    ).toEqual({ status: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.logs).toContainEqual({
      event: "analytics.capture_failed",
      code: "analytics.timeout",
    });

    const batchedFailing = fakeIngest({ status: 503 });
    const batched = emitter({ fetch: batchedFailing.fetch, shutdownTimeoutMs: 200 });
    await batched.instance.capture({
      subject: granted,
      event: "task_created",
      properties: created,
      eventId,
    });
    await expect(batched.instance.flush()).resolves.toBeUndefined();
    await expect(batched.instance.shutdown()).resolves.toBeUndefined();
  });

  it("attributes a provider failure only to the immediate capture whose send failed", async () => {
    const slowId = "0192f0a0-0000-7000-8000-0000000e0a01";
    const failingId = "0192f0a0-0000-7000-8000-0000000e0a02";
    const slowInFlight = deferred();
    const releaseSlow = deferred();
    const fetch: PostHogNodeFetch = async (_url, options) => {
      const [event] = (JSON.parse(decode(options.body)) as { batch: Array<{ uuid: string }> })
        .batch;
      if (event?.uuid === slowId) {
        slowInFlight.resolve();
        await releaseSlow.promise;
        return ingestResponse(200);
      }
      // Fail only while the other capture's request is still open, so their sends overlap.
      await slowInFlight.promise;
      return ingestResponse(500);
    };
    const { instance, logs } = emitter({ fetch, delivery: "immediate" });

    const slow = instance.capture({
      subject: granted,
      event: "task_created",
      properties: created,
      eventId: slowId,
    });
    const failing = instance.capture({
      subject: granted,
      event: "task_created",
      properties: created,
      eventId: failingId,
    });

    // The failure is reported while the slow send is still waiting for its response.
    expect(await failing).toEqual({ status: "failed", reason: "provider_error" });
    releaseSlow.resolve();
    expect(await slow).toEqual({ status: "sent" });
    expect(logs).toEqual([{ event: "analytics.capture_failed", code: "analytics.provider_error" }]);
    await instance.shutdown();
  });

  it("keeps outcomes separate across many overlapping immediate captures", async () => {
    const count = 12;
    const ids = Array.from(
      { length: count },
      (_, index) => `0192f0a0-0000-7000-8000-0000000e0b${String(index).padStart(2, "0")}`,
    );
    const failingIds = new Set(ids.filter((_, index) => index % 3 === 1));
    const allInFlight = deferred();
    let inFlight = 0;
    const fetch: PostHogNodeFetch = async (_url, options) => {
      const [event] = (JSON.parse(decode(options.body)) as { batch: Array<{ uuid: string }> })
        .batch;
      inFlight += 1;
      if (inFlight === count) allInFlight.resolve();
      // Every request waits until all of them are open, then they settle in reverse order.
      await allInFlight.promise;
      const position = ids.indexOf(event?.uuid ?? "");
      await new Promise((resolve) => setTimeout(resolve, (count - position) * 2));
      return ingestResponse(failingIds.has(event?.uuid ?? "") ? 503 : 200);
    };
    const { instance, logs } = emitter({ fetch, delivery: "immediate" });

    const outcomes = await Promise.all(
      ids.map((id) =>
        instance.capture({
          subject: granted,
          event: "task_created",
          properties: created,
          eventId: id,
        }),
      ),
    );

    expect(outcomes).toEqual(
      ids.map((id) =>
        failingIds.has(id)
          ? { status: "failed", reason: "provider_error" }
          : { status: "sent" as const },
      ),
    );
    expect(logs).toEqual(
      [...failingIds].map(() => ({
        event: "analytics.capture_failed",
        code: "analytics.provider_error",
      })),
    );
    await instance.shutdown();
  });

  it("still logs provider errors from batched background flushes", async () => {
    const { fetch } = fakeIngest({ status: 503 });
    const { instance, logs } = emitter({ fetch, flushAt: 1, flushIntervalMs: 60_000 });
    expect(
      await instance.capture({
        subject: granted,
        event: "task_created",
        properties: created,
        eventId,
      }),
    ).toEqual({ status: "queued" });
    await vi.waitFor(() =>
      expect(logs).toContainEqual({
        event: "analytics.provider_error",
        code: "analytics.provider_error",
      }),
    );
    expect(JSON.stringify(logs)).not.toContain(analyticsId);
    await instance.shutdown();
  });

  it("bounds the batched queue, dropping the oldest events while the provider is unreachable", async () => {
    let reachable = false;
    const sent: string[] = [];
    const fetch: PostHogNodeFetch = async (_url, options) => {
      if (!reachable) throw new TypeError("network unreachable");
      const payload = JSON.parse(decode(options.body)) as { batch: Array<{ uuid: string }> };
      sent.push(...payload.batch.map((event) => event.uuid));
      return {
        status: 200,
        text: async () => "{}",
        json: async () => ({}),
        headers: { get: () => null },
      } as unknown as Awaited<ReturnType<PostHogNodeFetch>>;
    };
    const { instance } = emitter({ fetch, flushAt: 50, flushIntervalMs: 60_000, maxQueueSize: 3 });
    const ids = Array.from(
      { length: 10 },
      (_, index) => `0192f0a0-0000-7000-8000-0000000e00${String(index).padStart(2, "0")}`,
    );
    for (const id of ids) {
      await instance.capture({
        subject: granted,
        event: "task_created",
        properties: created,
        eventId: id,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    reachable = true;
    await instance.flush();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent).toEqual(ids.slice(10 - sent.length));
    await instance.shutdown();
  });

  it("requires an https PostHog host", () => {
    const { fetch } = fakeIngest();
    expect(() => emitter({ fetch, host: "http://us.i.posthog.com" })).toThrow();
  });
});

describe("PostHog person deletion (§5.6)", () => {
  // A throwaway key generated per run; never a real credential.
  const personalApiKey = `phx_test_${crypto.randomUUID()}`;
  const personUuid = "0192f0a0-0000-4000-8000-00000000beef";

  function scripted(responses: Array<Response | Error>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch: PostHogFetch = async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    };
    const client = createPostHogPersonDeletionClient({ personalApiKey, projectId: "12345", fetch });
    return { client, calls };
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  async function deletionError(promise: Promise<unknown>): Promise<PostHogDeletionError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(PostHogDeletionError);
      const typed = error as PostHogDeletionError;
      expect(`${typed.message} ${typed.stack}`).not.toContain(analyticsId);
      expect(`${typed.message} ${typed.stack}`).not.toContain(personalApiKey);
      return typed;
    }
    throw new Error("expected failure");
  }

  const lookup = (uuids: readonly string[]) =>
    json(200, {
      results: uuids.map((uuid, index) => ({ id: index + 1, uuid, distinct_ids: [analyticsId] })),
    });

  it("looks up person UUIDs, then requests person, event and recording deletion with the personal key", async () => {
    const { client, calls } = scripted([
      lookup([personUuid]),
      json(202, {
        persons_found: 1,
        persons_deleted: 1,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: true,
        deletion_errors: [],
      }),
    ]);
    expect(await client.requestDeletion(analyticsId)).toEqual({
      status: 202,
      personsFound: 1,
      personsDeleted: 1,
      eventsQueuedForDeletion: true,
      recordingsQueuedForDeletion: true,
      personUuids: [personUuid],
      failedPersonUuids: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      `https://us.posthog.com/api/projects/12345/persons/?distinct_id=${encodeURIComponent(analyticsId)}`,
    );
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe(
      `Bearer ${personalApiKey}`,
    );
    const call = calls[1];
    expect(call?.url).toBe("https://us.posthog.com/api/projects/12345/persons/bulk_delete/");
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${personalApiKey}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      distinct_ids: [analyticsId],
      delete_events: true,
      delete_recordings: true,
    });
  });

  it("reports persons PostHog could not delete", async () => {
    const { client } = scripted([
      lookup([personUuid]),
      json(202, {
        persons_found: 1,
        persons_deleted: 0,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: true,
        deletion_errors: [{ person_uuid: personUuid }],
      }),
    ]);
    expect((await client.requestDeletion(analyticsId)).failedPersonUuids).toEqual([personUuid]);
  });

  it.each([
    [401, "analytics.deletion_unauthorized", false],
    [403, "analytics.deletion_unauthorized", false],
    [400, "analytics.deletion_rejected", false],
    [429, "analytics.deletion_rate_limited", true],
    [500, "analytics.deletion_unavailable", true],
    [200, "analytics.deletion_rejected", false],
  ] as const)("maps HTTP %i to %s", async (status, code, retryable) => {
    const { client } = scripted([
      lookup([personUuid]),
      json(status, { detail: analyticsId }, { "retry-after": "30" }),
    ]);
    const error = await deletionError(client.requestDeletion(analyticsId));
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("never deletes when the lookup fails, and repeats safely after persons are gone", async () => {
    const failing = scripted([json(429, {}, { "retry-after": "5" })]);
    const error = await deletionError(failing.client.requestDeletion(analyticsId));
    expect(error).toMatchObject({ code: "analytics.deletion_rate_limited", retryAfterSeconds: 5 });
    expect(failing.calls).toHaveLength(1);

    const repeat = scripted([
      lookup([]),
      json(202, {
        persons_found: 0,
        persons_deleted: 0,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: true,
        deletion_errors: [],
      }),
    ]);
    expect(await repeat.client.requestDeletion(analyticsId)).toMatchObject({
      personsFound: 0,
      personUuids: [],
    });
  });

  it("maps network failures and malformed responses", async () => {
    const network = scripted([new TypeError(`fetch failed ${analyticsId}`)]);
    expect((await deletionError(network.client.requestDeletion(analyticsId))).code).toBe(
      "analytics.deletion_network_error",
    );
    const malformed = scripted([lookup([]), json(202, { persons_found: "one" })]);
    expect((await deletionError(malformed.client.requestDeletion(analyticsId))).code).toBe(
      "analytics.deletion_invalid_response",
    );
  });

  it("finds person UUIDs by distinct id and polls event deletion status", async () => {
    const { client, calls } = scripted([
      json(200, { results: [{ id: 7, uuid: personUuid, distinct_ids: [analyticsId] }] }),
      json(200, {
        results: [{ person_uuid: personUuid, status: "pending", delete_verified_at: null }],
      }),
      json(200, {
        results: [
          {
            person_uuid: personUuid,
            status: "completed",
            delete_verified_at: "2026-09-20T02:00:00Z",
          },
        ],
      }),
      json(200, { results: [] }),
    ]);
    expect(await client.findPersonUuids(analyticsId)).toEqual([personUuid]);
    expect(calls[0]?.url).toBe(
      `https://us.posthog.com/api/projects/12345/persons/?distinct_id=${encodeURIComponent(analyticsId)}`,
    );
    expect(await client.eventDeletionStatus(personUuid)).toBe("pending");
    expect(calls[1]?.url).toBe(
      `https://us.posthog.com/api/projects/12345/persons/deletion_status/?person_uuid=${personUuid}&status=all`,
    );
    expect(await client.eventDeletionStatus(personUuid)).toBe("completed");
    expect(await client.eventDeletionStatus(personUuid)).toBe("not_found");
  });

  it("validates configuration and inputs", async () => {
    expect(() =>
      createPostHogPersonDeletionClient({ personalApiKey: "", projectId: "1" }),
    ).toThrow();
    expect(() => createPostHogPersonDeletionClient({ personalApiKey, projectId: "abc" })).toThrow();
    expect(() =>
      createPostHogPersonDeletionClient({
        personalApiKey,
        projectId: "1",
        appHost: "http://x.example",
      }),
    ).toThrow();
    const { client, calls } = scripted([]);
    await deletionError(client.requestDeletion(" "));
    await deletionError(client.findPersonUuids(""));
    await deletionError(client.eventDeletionStatus("not-a-uuid"));
    expect(calls).toEqual([]);
  });
});
