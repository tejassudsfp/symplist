import { eventIdSchema } from "@symplist/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeStatus, TopicHandlers } from "@/lib/realtime";
import { type AccessRealtimeClient, connectAccessRealtime } from "./session-runtime.ts";
import { admittedAccess } from "./test-support.tsx";

function fakeClient() {
  const state = {
    connected: 0,
    disconnected: 0,
    unsubscribed: 0,
    handlers: null as TopicHandlers | null,
    status: null as ((status: RealtimeStatus) => void) | null,
  };
  const client: AccessRealtimeClient = {
    connect: () => {
      state.connected += 1;
    },
    disconnect: () => {
      state.disconnected += 1;
    },
    onStatusChange: (listener) => {
      state.status = listener;
      return () => {
        state.status = null;
      };
    },
    subscribeUser: ((_openTasks: unknown, handlers: TopicHandlers) => {
      state.handlers = handlers;
      return {
        topic: "user" as const,
        setOpenTasks: () => undefined,
        unsubscribe: () => {
          state.unsubscribed += 1;
        },
      };
    }) as AccessRealtimeClient["subscribeUser"],
  };
  return { client, state };
}

const accessChanged = {
  t: "ev" as const,
  topic: "user" as const,
  seq: 1,
  id: eventIdSchema.parse("01929f3e-7c1a-7b2e-9a55-3c2f1d0ef001"),
  type: "access.changed",
  data: { accessState: admittedAccess },
};

describe("the access realtime subscription (§7)", () => {
  it("subscribes to the user topic and re-reads the identity on access.changed", () => {
    const refresh = vi.fn(async () => undefined);
    const { client, state } = fakeClient();
    const stop = connectAccessRealtime({
      store: { refresh } as never,
      createClient: () => client,
    });
    expect(state.connected).toBe(1);
    state.handlers?.onEvent?.(accessChanged);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    expect(state.unsubscribed).toBe(1);
    expect(state.disconnected).toBe(1);
  });

  it("ignores other events and malformed data", () => {
    const refresh = vi.fn(async () => undefined);
    const { client, state } = fakeClient();
    connectAccessRealtime({ store: { refresh } as never, createClient: () => client });
    state.handlers?.onEvent?.({ ...accessChanged, type: "tasks.changed" });
    state.handlers?.onEvent?.({ ...accessChanged, data: { accessState: { betaState: "nope" } } });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-reads the identity when the socket closes with 4401 or 4403", () => {
    const refresh = vi.fn(async () => undefined);
    const { client, state } = fakeClient();
    connectAccessRealtime({ store: { refresh } as never, createClient: () => client });
    state.status?.("reconnecting");
    expect(refresh).not.toHaveBeenCalled();
    state.status?.("unauthorized");
    state.status?.("forbidden");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no socket origin is configured", () => {
    const refresh = vi.fn(async () => undefined);
    const stop = connectAccessRealtime({ store: { refresh } as never, createClient: () => null });
    expect(() => stop()).not.toThrow();
  });

  it("never lets a failing client break the page", () => {
    const stop = connectAccessRealtime({
      store: { refresh: vi.fn() } as never,
      createClient: () => {
        throw new Error("no socket");
      },
    });
    expect(() => stop()).not.toThrow();
  });
});
