import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ConversationId, conversationIdSchema, idSchema } from "./ids.ts";
import {
  clientFrameSchema,
  conversationTopic,
  decodeClientFrame,
  defineEvents,
  eventEnvelopeSchema,
  isUserTopicEventType,
  misownedUserTopicEvents,
  parseTopic,
  serverFrameSchemaFor,
  topicSchema,
  unadmittedUserTopicEventTypes,
  userTopicEventOwners,
  userTopicEventTypes,
  userTopicSnapshotSchema,
  wsCloseCodes,
  wsMaxOpenTasks,
  wsMaxPayloadBytes,
  wsMaxSubscriptions,
  wsPath,
} from "./ws.ts";

const id = (n: number) => `0199a5a0-7c1f-7000-8000-${n.toString(16).padStart(12, "0")}`;
const conversationId: ConversationId = conversationIdSchema.parse(id(1));
const conversation = `conversation:${id(1)}`;
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("protocol constants (§7)", () => {
  it("matches the gateway limits", () => {
    expect(wsPath).toBe("/v1/ws");
    expect(wsMaxPayloadBytes).toBe(16_384);
    expect(wsMaxOpenTasks).toBe(20);
    expect(wsMaxSubscriptions).toBe(50);
    expect(wsCloseCodes).toEqual({
      goingAway: 1001,
      policyViolation: 1008,
      sessionEnded: 4401,
      accessLost: 4403,
    });
  });
});

describe("topics", () => {
  it("names and parses the user and conversation topics", () => {
    expect(conversationTopic(conversationId)).toBe(conversation);
    expect(parseTopic("user")).toEqual({ kind: "user" });
    expect(parseTopic(conversation)).toEqual({ kind: "conversation", conversationId: id(1) });
    expect(topicSchema.parse("user")).toBe("user");
    expect(topicSchema.parse(conversation)).toBe(conversation);
  });

  it.each([
    "users",
    "conversation:",
    "conversation:not-an-id",
    `conversation:${id(1).toUpperCase()}`,
    `conversation:${id(1)} `,
    `conversation:${id(1)}:extra`,
    `task:${id(1)}`,
  ])("rejects %j", (topic) => {
    expect(parseTopic(topic)).toBeNull();
    expect(topicSchema.safeParse(topic).success).toBe(false);
  });
});

describe("client frames", () => {
  const frames = [
    { t: "sub", topic: "user", cursor: null, openTasks: [id(10), id(11)] },
    { t: "sub", topic: "user", cursor: null, openTasks: [] },
    { t: "sub", topic: conversation, cursor: null },
    { t: "sub", topic: conversation, cursor: 42 },
    { t: "unsub", topic: "user" },
    { t: "unsub", topic: conversation },
    { t: "ping" },
  ];

  it.each(frames)("round-trips %j", (frame) => {
    expect(clientFrameSchema.parse(roundTrip(frame))).toEqual(frame);
    expect(decodeClientFrame(JSON.stringify(frame))).toEqual({ ok: true, frame });
  });

  it.each([
    ["an unknown frame type", { t: "send", topic: conversation, text: "hi" }],
    ["a command smuggled onto ping", { t: "ping", approve: id(3) }],
    ["a user subscription with a cursor", { t: "sub", topic: "user", cursor: 5, openTasks: [] }],
    ["a user subscription without open tasks", { t: "sub", topic: "user", cursor: null }],
    [
      "more than 20 open tasks",
      {
        t: "sub",
        topic: "user",
        cursor: null,
        openTasks: Array.from({ length: 21 }, (_, n) => id(n)),
      },
    ],
    ["repeated open tasks", { t: "sub", topic: "user", cursor: null, openTasks: [id(1), id(1)] }],
    ["an invalid open task id", { t: "sub", topic: "user", cursor: null, openTasks: ["task-1"] }],
    [
      "a conversation subscription with open tasks",
      { t: "sub", topic: conversation, cursor: null, openTasks: [] },
    ],
    ["a negative cursor", { t: "sub", topic: conversation, cursor: -1 }],
    ["a fractional cursor", { t: "sub", topic: conversation, cursor: 1.5 }],
    ["a string cursor", { t: "sub", topic: conversation, cursor: "5" }],
    ["a missing cursor", { t: "sub", topic: conversation }],
    ["an unknown topic", { t: "unsub", topic: "admin" }],
    ["an unsub without a topic", { t: "unsub" }],
  ])("rejects %s", (_label, frame) => {
    expect(clientFrameSchema.safeParse(frame).success).toBe(false);
    expect(decodeClientFrame(JSON.stringify(frame))).toEqual({ ok: false, code: "validation" });
  });

  it("rejects malformed, non-object, prototype-polluting and oversized text", () => {
    for (const text of [
      "",
      "{",
      "null",
      "[]",
      '"ping"',
      '{"t":"ping","__proto__":{"admin":true}}',
      `{"t":"ping","pad":"${"x".repeat(wsMaxPayloadBytes)}"}`,
    ]) {
      expect(decodeClientFrame(text)).toEqual({ ok: false, code: "validation" });
    }
    const padded = `${JSON.stringify({ t: "ping" })}${" ".repeat(wsMaxPayloadBytes)}`;
    expect(decodeClientFrame(padded)).toEqual({ ok: false, code: "validation" });
  });
});

describe("server frames", () => {
  const events = defineEvents({
    "tasks.changed": z.strictObject({
      taskTreeVersion: z.number().int(),
      taskIds: z.array(idSchema),
    }),
    chunk: z.strictObject({ runId: idSchema, part: z.string() }),
  });
  const schema = serverFrameSchemaFor(events);
  const base = { seq: 7, id: id(99) };

  it.each([
    {
      t: "ev",
      topic: "user",
      ...base,
      type: "tasks.changed",
      data: { taskTreeVersion: 2, taskIds: [id(5)] },
    },
    { t: "ev", topic: conversation, ...base, type: "chunk", data: { runId: id(6), part: "text" } },
    { t: "snapshot", topic: "user", seq: 0, data: { unreadCount: 0 } },
    { t: "resync", topic: conversation },
    { t: "err", code: "not_found" },
    { t: "pong" },
  ])("round-trips %j", (frame) => {
    expect(schema.parse(roundTrip(frame))).toEqual(frame);
  });

  it.each([
    ["an unknown event type", { t: "ev", topic: "user", ...base, type: "tasks.deleted", data: {} }],
    [
      "invalid event data",
      {
        t: "ev",
        topic: "user",
        ...base,
        type: "tasks.changed",
        data: { taskTreeVersion: "2", taskIds: [] },
      },
    ],
    [
      "extra event data",
      {
        t: "ev",
        topic: "user",
        ...base,
        type: "tasks.changed",
        data: { taskTreeVersion: 2, taskIds: [], title: "secret" },
      },
    ],
    [
      "a user event on a conversation topic",
      {
        t: "ev",
        topic: conversation,
        ...base,
        type: "tasks.changed",
        data: { taskTreeVersion: 2, taskIds: [] },
      },
    ],
    [
      "a conversation event on the user topic",
      { t: "ev", topic: "user", ...base, type: "chunk", data: { runId: id(6), part: "text" } },
    ],
    [
      "a missing event id",
      { t: "ev", topic: conversation, seq: 1, type: "chunk", data: { runId: id(6), part: "x" } },
    ],
    [
      "a negative seq",
      {
        t: "ev",
        topic: conversation,
        seq: -1,
        id: id(1),
        type: "chunk",
        data: { runId: id(6), part: "x" },
      },
    ],
    ["a snapshot without data", { t: "snapshot", topic: "user", seq: 0 }],
    ["an err frame with a message", { t: "err", code: "not_found", message: "Conversation x" }],
    ["an err frame with a malformed code", { t: "err", code: "Not Found" }],
    ["a pong with a payload", { t: "pong", at: 1 }],
    ["an unknown frame", { t: "hello" }],
  ])("rejects %s", (_label, frame) => {
    expect(schema.safeParse(frame).success).toBe(false);
  });

  it("accepts any well-formed event in the base envelope", () => {
    const frame = { t: "ev", topic: "user", ...base, type: "future.event", data: null };
    expect(eventEnvelopeSchema.parse(frame)).toEqual(frame);
    expect(eventEnvelopeSchema.safeParse({ ...frame, extra: 1 }).success).toBe(false);
  });

  it("validates the user topic snapshot", () => {
    const snapshot = {
      unreadCount: 2,
      taskTreeVersion: 9,
      heads: { [id(5)]: "3f786850e387550fdab836ed7e6dc881de23001b" },
      vaultUnlocked: false,
    };
    expect(userTopicSnapshotSchema.parse(roundTrip(snapshot))).toEqual(snapshot);
    expect(
      userTopicSnapshotSchema.safeParse({ ...snapshot, heads: { "task-5": "abc" } }).success,
    ).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, n) => [id(n), "abc"]));
    expect(userTopicSnapshotSchema.safeParse({ ...snapshot, heads: tooMany }).success).toBe(false);
    expect(userTopicSnapshotSchema.safeParse({ ...snapshot, vault: true }).success).toBe(false);
  });
});

describe("events", () => {
  it("lists the §7 user-topic events with their owning features", () => {
    expect(userTopicEventOwners).toEqual({
      "tasks.changed": "workspace",
      "notifications.created": "scheduling",
      "notifications.read": "scheduling",
      "notifications.summary": "scheduling",
      "access.changed": "access",
      "preferences.changed": "workspace",
      "run.status": "simon",
      "document.head_changed": "documents",
      "schedule.changed": "scheduling",
      "vault.locked": "vault",
      "connection.status_changed": "connections",
      "share_grant.changed": "sharing",
      "search.freshness": "search",
    });
    expect(userTopicEventTypes).toHaveLength(13);
    expect(unadmittedUserTopicEventTypes).toEqual(["access.changed"]);
    expect(isUserTopicEventType("access.changed")).toBe(true);
    expect(isUserTopicEventType("chunk")).toBe(false);
    expect(isUserTopicEventType("toString")).toBe(false);
  });

  it("reports user-topic events declared by a feature that does not own them", () => {
    const data = z.strictObject({});
    expect(
      misownedUserTopicEvents({ workspace: { "tasks.changed": data }, simon: { chunk: data } }),
    ).toEqual([]);
    expect(misownedUserTopicEvents({ vault: { "tasks.changed": data } })).toEqual([
      "tasks.changed is owned by workspace but declared by vault",
    ]);
  });

  it("rejects malformed event type names", () => {
    expect(() => defineEvents({ TasksChanged: z.null() })).toThrow(/Invalid WebSocket event type/);
    expect(() => defineEvents({ "tasks changed": z.null() })).toThrow(
      /Invalid WebSocket event type/,
    );
  });
});
