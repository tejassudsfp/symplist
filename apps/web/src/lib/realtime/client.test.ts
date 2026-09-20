import {
  type ConversationId,
  conversationIdSchema,
  type TaskId,
  taskIdSchema,
} from "@symplist/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_FORBIDDEN,
  CLOSE_UNAUTHORIZED,
  RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeStatus,
  type TopicHandlers,
  type WebSocketLike,
} from "./client.ts";
import { conversationTopic, MAX_SERVER_FRAME_LENGTH, parseServerFrame } from "./frames.ts";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  serverSend(frame: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: typeof frame === "string" ? frame : JSON.stringify(frame),
      }),
    );
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

/** A valid lowercase UUIDv7 literal: `kind` names the id family, `sequence` fills the last group. */
function uuidV7(kind: "a" | "c" | "e", sequence: number): string {
  return `01929f3e-7c1a-7${kind}00-8000-${sequence.toString(16).padStart(12, "0")}`;
}

const taskId = (sequence: number): TaskId => taskIdSchema.parse(uuidV7("a", sequence));
const conversationIdAt = (sequence: number): ConversationId =>
  conversationIdSchema.parse(uuidV7("c", sequence));
const eventId = (sequence: number): string => uuidV7("e", sequence);

const conversationId = conversationIdAt(1);
const conversation = conversationTopic(conversationId);

let online = true;
let onlineListeners: Array<() => void> = [];
let statuses: RealtimeStatus[] = [];
let clientErrors: string[] = [];
let random = 0.5;

function makeClient(overrides: Partial<RealtimeClientOptions> = {}) {
  return new RealtimeClient({
    url: "wss://api.symplist.test/v1/ws",
    createSocket: (url) => new FakeSocket(url),
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    now: () => Date.now(),
    random: () => random,
    network: {
      isOnline: () => online,
      subscribe: (listener) => {
        onlineListeners.push(listener);
        return () => {
          onlineListeners = onlineListeners.filter((candidate) => candidate !== listener);
        };
      },
    },
    onStatus: (status) => statuses.push(status),
    onError: (code) => clientErrors.push(code),
    ...overrides,
  });
}

const latest = () => {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
};

function recorder() {
  const events: unknown[] = [];
  const handlers: TopicHandlers = {
    onEvent: (frame) => events.push(["ev", frame.seq, frame.type]),
    onSnapshot: (frame) => events.push(["snapshot", frame.seq]),
    onResync: () => events.push(["resync"]),
    onError: (code) => events.push(["err", code]),
  };
  return { events, handlers };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  online = true;
  onlineListeners = [];
  statuses = [];
  clientErrors = [];
  random = 0.5;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subscriptions", () => {
  it("subscribes to the user topic with open tasks and to conversations with cursors", () => {
    const client = makeClient();
    const user = recorder();
    client.subscribeUser([taskId(1), taskId(2)], user.handlers);
    client.connect();
    expect(latest().url).toBe("wss://api.symplist.test/v1/ws");
    expect(statuses).toEqual(["connecting"]);
    latest().serverOpen();
    client.subscribeConversation(conversationId, recorder().handlers);
    expect(latest().sent).toEqual([
      { t: "sub", topic: "user", cursor: null, openTasks: [taskId(1), taskId(2)] },
      { t: "sub", topic: conversation, cursor: null },
    ]);
    expect(client.status).toBe("open");
  });

  it("delivers snapshots and events, advances cursors and drops replayed duplicates", () => {
    const client = makeClient();
    const convo = recorder();
    client.connect();
    latest().serverOpen();
    client.subscribeConversation(conversationId, convo.handlers);
    latest().serverSend({ t: "snapshot", topic: conversation, seq: 10, data: { messages: [] } });
    latest().serverSend({
      t: "ev",
      topic: conversation,
      seq: 11,
      id: eventId(11),
      type: "chunk",
      data: {},
    });
    latest().serverSend({
      t: "ev",
      topic: conversation,
      seq: 11,
      id: eventId(11),
      type: "chunk",
      data: {},
    });
    latest().serverSend({
      t: "ev",
      topic: conversation,
      seq: 9,
      id: eventId(9),
      type: "chunk",
      data: {},
    });
    latest().serverSend({
      t: "ev",
      topic: conversation,
      seq: 12,
      id: eventId(12),
      type: "run.status",
      data: {},
    });
    expect(convo.events).toEqual([
      ["snapshot", 10],
      ["ev", 11, "chunk"],
      ["ev", 12, "run.status"],
    ]);
    expect(client.cursorOf(conversation)).toBe(12);
  });

  it("shares one topic between listeners and unsubscribes when the last one leaves", () => {
    const client = makeClient();
    client.connect();
    latest().serverOpen();
    const first = client.subscribeConversation(conversationId, recorder().handlers);
    const second = client.subscribeConversation(conversationId, recorder().handlers);
    expect(latest().sent).toHaveLength(1);
    first.unsubscribe();
    expect(latest().sent).toHaveLength(1);
    second.unsubscribe();
    expect(latest().sent.at(-1)).toEqual({ t: "unsub", topic: conversation });
  });

  it("updates open tasks and validates limits", () => {
    const client = makeClient();
    client.connect();
    latest().serverOpen();
    const user = client.subscribeUser([], recorder().handlers);
    user.setOpenTasks([taskId(1)]);
    user.setOpenTasks([taskId(1)]);
    // Repeated ids are sent once, so this is the same set of open tasks.
    user.setOpenTasks([taskId(1), taskId(1)]);
    expect(latest().sent).toEqual([
      { t: "sub", topic: "user", cursor: null, openTasks: [] },
      { t: "sub", topic: "user", cursor: null, openTasks: [taskId(1)] },
    ]);
    expect(() =>
      user.setOpenTasks(Array.from({ length: 21 }, (_, index) => taskId(index))),
    ).toThrow(RangeError);
    expect(() =>
      client.subscribeConversation("../../etc" as ConversationId, recorder().handlers),
    ).toThrow(TypeError);
    expect(() => client.subscribeConversation("" as ConversationId, recorder().handlers)).toThrow(
      TypeError,
    );
  });

  it("rejects task and conversation ids that are not lowercase UUIDv7s", () => {
    const client = makeClient();
    client.connect();
    latest().serverOpen();
    const invalidIds = [
      "task-1",
      "",
      // UUIDv4
      "3b241101-e2bb-4255-8caf-4136c566a962",
      // Uppercase UUIDv7
      uuidV7("a", 1).toUpperCase(),
      // Wrong variant nibble
      "01929f3e-7c1a-7a00-c000-000000000001",
      `${uuidV7("a", 1)}\n`,
    ];
    for (const invalid of invalidIds) {
      expect(() => client.subscribeUser([invalid as TaskId], recorder().handlers)).toThrow(
        TypeError,
      );
      expect(() =>
        client.subscribeConversation(invalid as ConversationId, recorder().handlers),
      ).toThrow(TypeError);
      expect(() => conversationTopic(invalid as ConversationId)).toThrow(TypeError);
    }
    const user = client.subscribeUser([taskId(1)], recorder().handlers);
    expect(() => user.setOpenTasks([taskId(2), "task-3" as TaskId])).toThrow(TypeError);
    // Rejected ids never reach the socket or leave a subscription behind.
    expect(latest().sent).toEqual([
      { t: "sub", topic: "user", cursor: null, openTasks: [taskId(1)] },
    ]);
  });

  it("refuses more than 50 subscriptions", () => {
    const client = makeClient();
    for (let index = 0; index < 50; index += 1) {
      client.subscribeConversation(conversationIdAt(index), recorder().handlers);
    }
    expect(() => client.subscribeConversation(conversationIdAt(50), recorder().handlers)).toThrow(
      RangeError,
    );
  });

  it("ignores malformed or unexpected frames", () => {
    const client = makeClient();
    const convo = recorder();
    client.connect();
    latest().serverOpen();
    client.subscribeConversation(conversationId, convo.handlers);
    for (const frame of [
      "not json",
      "{}",
      { t: "ev", topic: conversation, seq: -1, id: eventId(1), type: "chunk", data: {} },
      { t: "ev", topic: conversation, seq: 1, id: "x", type: "chunk", data: {} },
      { t: "ev", topic: conversation, seq: 1, id: eventId(1), type: "Chunk!", data: {} },
      { t: "ev", topic: "conversation:<script>", seq: 1, id: eventId(1), type: "chunk", data: {} },
      {
        t: "ev",
        topic: conversation.toUpperCase(),
        seq: 1,
        id: eventId(1),
        type: "chunk",
        data: {},
      },
      { t: "snapshot", topic: "conversation:other", seq: 1, data: {} },
      { t: "snapshot", topic: conversation, seq: 1, data: {}, extra: true },
      { t: "shell", cmd: "rm" },
      JSON.stringify({
        t: "snapshot",
        topic: conversation,
        seq: 1,
        data: "x".repeat(MAX_SERVER_FRAME_LENGTH),
      }),
    ]) {
      latest().serverSend(frame);
    }
    expect(convo.events).toEqual([]);
    expect(parseServerFrame(42)).toBeNull();
  });
});

describe("resync, snapshot and err handling", () => {
  it("resets the cursor on resync and resubscribes for a fresh snapshot", () => {
    const client = makeClient();
    const convo = recorder();
    client.connect();
    latest().serverOpen();
    client.subscribeConversation(conversationId, convo.handlers);
    latest().serverSend({
      t: "ev",
      topic: conversation,
      seq: 5,
      id: eventId(5),
      type: "chunk",
      data: {},
    });
    latest().serverSend({ t: "resync", topic: conversation });
    expect(client.cursorOf(conversation)).toBeNull();
    expect(latest().sent.at(-1)).toEqual({ t: "sub", topic: conversation, cursor: null });
    latest().serverSend({ t: "snapshot", topic: conversation, seq: 40, data: {} });
    expect(convo.events).toEqual([["ev", 5, "chunk"], ["resync"], ["snapshot", 40]]);
  });

  it("attributes err to the oldest unconfirmed subscription and forgets unknown conversations", () => {
    const client = makeClient();
    const convo = recorder();
    const user = recorder();
    client.connect();
    latest().serverOpen();
    client.subscribeUser([], user.handlers);
    latest().serverSend({ t: "snapshot", topic: "user", seq: 1, data: {} });
    client.subscribeConversation(conversationId, convo.handlers);
    latest().serverSend({ t: "err", code: "not_found" });
    expect(convo.events).toEqual([["err", "not_found"]]);
    expect(user.events).toEqual([["snapshot", 1]]);
    // A reconnect never resubscribes to the unknown conversation.
    latest().serverClose(1006);
    vi.advanceTimersByTime(1000);
    latest().serverOpen();
    expect(latest().sent).toEqual([{ t: "sub", topic: "user", cursor: null, openTasks: [] }]);
  });

  it("reports err frames that match no pending subscription to the client", () => {
    const client = makeClient();
    client.connect();
    latest().serverOpen();
    latest().serverSend({ t: "err", code: "rate.limited" });
    expect(clientErrors).toEqual(["rate.limited"]);
  });
});

describe("reconnect", () => {
  it("reconnects with jittered exponential backoff and resubscribes with cursors", () => {
    const client = makeClient({ initialBackoffMs: 1000, maxBackoffMs: 8000 });
    client.subscribeUser([taskId(1)], recorder().handlers);
    client.subscribeConversation(conversationId, recorder().handlers);
    client.connect();
    latest().serverOpen();
    latest().serverSend({
      t: "ev",
      topic: conversation,
      seq: 77,
      id: eventId(77),
      type: "chunk",
      data: {},
    });

    random = 0;
    latest().serverClose(1006);
    expect(client.status).toBe("reconnecting");
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    random = 1;
    latest().serverClose(1006);
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    latest().serverClose(1006);
    latest().serverClose(1006);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      vi.advanceTimersByTime(8000);
      latest().serverClose(1006);
    }
    // The delay is capped at maxBackoffMs.
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(8000);
    expect(FakeSocket.instances.length).toBe(count + 1);

    latest().serverOpen();
    expect(latest().sent).toEqual([
      { t: "sub", topic: "user", cursor: null, openTasks: [taskId(1)] },
      { t: "sub", topic: conversation, cursor: 77 },
    ]);
  });

  it("resets the backoff after a stable connection", () => {
    const client = makeClient({ initialBackoffMs: 1000, stableAfterMs: 5000 });
    client.connect();
    latest().serverOpen();
    latest().serverClose(1006);
    vi.advanceTimersByTime(1000);
    latest().serverOpen();
    vi.advanceTimersByTime(5000);
    random = 1;
    latest().serverClose(1001);
    // Without the reset this second failure would wait up to 2000 ms.
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it.each([
    [CLOSE_UNAUTHORIZED, "unauthorized"],
    [CLOSE_FORBIDDEN, "forbidden"],
  ] as const)("stops on close %i and reports %s", (code, status) => {
    const client = makeClient();
    client.connect();
    latest().serverOpen();
    latest().serverClose(code);
    expect(client.status).toBe(status);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    client.connect();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("does not reconnect after disconnect", () => {
    const client = makeClient();
    client.connect();
    latest().serverOpen();
    client.disconnect();
    expect(latest().closedWith).toEqual({ code: 1000, reason: "client disconnect" });
    expect(client.status).toBe("closed");
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("waits while offline and reconnects immediately when the network returns", () => {
    const client = makeClient();
    client.connect();
    latest().serverOpen();
    online = false;
    latest().serverClose(1006);
    expect(client.status).toBe("offline");
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    online = true;
    for (const listener of onlineListeners) listener();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.status).toBe("connecting");
  });
});

describe("heartbeat and frame budget", () => {
  it("pings on an interval and reconnects when nothing comes back", () => {
    const client = makeClient({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 500 });
    client.connect();
    latest().serverOpen();
    const first = latest();
    vi.advanceTimersByTime(1000);
    expect(first.sent).toEqual([{ t: "ping" }]);
    first.serverSend({ t: "pong" });
    vi.advanceTimersByTime(1000);
    expect(first.sent).toEqual([{ t: "ping" }, { t: "ping" }]);
    vi.advanceTimersByTime(500);
    expect(first.closedWith?.code).toBe(4000);
    expect(client.status).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("keeps client frames under the server's rate limit by queueing", () => {
    const client = makeClient({
      maxFramesPerWindow: 3,
      frameWindowMs: 10_000,
      heartbeatIntervalMs: 999_999,
    });
    for (let index = 0; index < 5; index += 1) {
      client.subscribeConversation(conversationIdAt(index), recorder().handlers);
    }
    client.connect();
    latest().serverOpen();
    expect(latest().sent).toHaveLength(3);
    vi.advanceTimersByTime(9_999);
    expect(latest().sent).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(latest().sent).toHaveLength(5);
  });
});
