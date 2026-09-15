import { describe, expect, it } from "vitest";
import {
  collectExecutionKinds,
  createRunRelaySource,
  type EventsContributor,
  eventsContributors,
  executorKindFor,
  internalEventBodySchema,
  runChunkBatchSchema,
  runOutputBodySchema,
  runOutputPath,
} from "./index.ts";

const id = "01996d2a-4c00-7000-8000-000000000001";
const owner = "01996d2a-4c00-7000-8000-000000000002";
const envelope = `sym1.1.${"A".repeat(16)}.${"B".repeat(40)}`;

describe("internal event wire format (§6.2)", () => {
  it("accepts ids, enums, counts, flags and small envelopes", () => {
    const body = {
      id,
      type: "notifications.created",
      ownerId: owner,
      occurredAt: 1_789_462_800_000,
      payload: { notificationId: id, count: 3, quiet: true, taskIds: [id], previewEnc: envelope },
    };
    expect(internalEventBodySchema.parse(body)).toEqual(body);
  });

  it.each([
    ["free text", { note: "hello world" }],
    ["an email address", { email: "maya@example.com" }],
    ["a negative count", { count: -1 }],
    ["a fractional number", { count: 1.5 }],
    ["a nested object", { nested: { a: 1 } }],
    ["a snake_case key", { task_id: id }],
  ] as const)("rejects %s in the payload", (_what, payload) => {
    expect(
      internalEventBodySchema.safeParse({
        id,
        type: "tasks.changed",
        ownerId: owner,
        occurredAt: 1,
        payload,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown top-level fields and non-UUIDv7 ids", () => {
    const base = { id, type: "tasks.changed", ownerId: owner, occurredAt: 1, payload: {} };
    expect(internalEventBodySchema.safeParse({ ...base, text: "x" }).success).toBe(false);
    expect(internalEventBodySchema.safeParse({ ...base, ownerId: "user-1" }).success).toBe(false);
  });

  it("describes run output bodies with a sym1 envelope and a monotonic seq", () => {
    expect(runOutputPath(id)).toBe(`/internal/v1/runs/${id}/output`);
    expect(runOutputBodySchema.parse({ runId: id, attempt: 1, seq: 0, envelope })).toBeTruthy();
    expect(
      runOutputBodySchema.safeParse({ runId: id, attempt: 1, seq: 0, envelope: "plain" }).success,
    ).toBe(false);
    expect(runOutputBodySchema.safeParse({ runId: id, attempt: 0, seq: 0, envelope }).success).toBe(
      false,
    );
  });

  it("accepts UI chunk batches keyed by their type only", () => {
    expect(runChunkBatchSchema.parse([{ type: "text-delta", id: "t", delta: "hi" }])).toHaveLength(
      1,
    );
    expect(runChunkBatchSchema.safeParse([]).success).toBe(false);
    expect(runChunkBatchSchema.safeParse([{ delta: "x" }]).success).toBe(false);
  });
});

describe("execution contributors (§8.1)", () => {
  it("registers every contributor file once", () => {
    expect(eventsContributors.map((contributor) => contributor.domain).sort()).toEqual([
      "account",
      "simon",
    ]);
    expect(() => collectExecutionKinds()).not.toThrow();
  });

  it("maps modes to executor kinds", () => {
    expect(executorKindFor("local")).toBe("local");
    expect(executorKindFor("durable")).toBe("trigger");
  });

  it("rejects duplicate kinds, duplicate Trigger tasks and malformed kinds", () => {
    const definition = { kind: "simon_run", triggerTaskId: "simon-run", payload: () => ({}) };
    const contributor = (kinds: EventsContributor["executionKinds"]): EventsContributor => ({
      domain: "simon",
      executionKinds: kinds,
    });
    expect(() => collectExecutionKinds([contributor([definition, definition])])).toThrow(/twice/);
    expect(() =>
      collectExecutionKinds([contributor([definition, { ...definition, kind: "other_run" }])]),
    ).toThrow(/claimed by two kinds/);
    expect(() =>
      collectExecutionKinds([contributor([{ ...definition, kind: "Bad-Kind" }])]),
    ).toThrow(/Invalid/);
  });

  it("builds at most one run relay source", () => {
    const db = {} as never;
    expect(createRunRelaySource({ db })).toBeNull();
    const source = { ownership: async () => null, state: async () => null };
    const withSource: EventsContributor = {
      domain: "simon",
      executionKinds: [],
      runRelaySource: () => source,
    };
    expect(createRunRelaySource({ db }, [withSource])).toBe(source);
    expect(() => createRunRelaySource({ db }, [withSource, withSource])).toThrow(/Only one/);
  });
});
