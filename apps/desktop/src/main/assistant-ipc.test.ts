/**
 * The assistant IPC group, exercised through the same registrar `registerIpcHandlers` hands it.
 *
 * Every argument here is one page script can send, so these tests are mostly about what happens when
 * it sends something else. The sender check itself belongs to `registerIpcHandlers` and is tested
 * with the rest of the registry; this is the inner of the two guards.
 */
import { describe, expect, it, vi } from "vitest";
import { assistantChannels } from "../shared/assistant.ts";
import type { AssistantService, GuardedHandle } from "./assistant-ipc.ts";
import { registerAssistantHandlers } from "./assistant-ipc.ts";
import { AssistantUnavailable } from "./harness/supervisor.ts";
import { silentMainLog } from "./log.ts";

function harness(overrides: Partial<AssistantService> = {}) {
  const calls: Record<string, unknown[][] | undefined> = {};
  const record =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      const recorded = calls[name] ?? [];
      recorded.push(args);
      calls[name] = recorded;
      return result;
    };
  const service: AssistantService = {
    status: record("status", Promise.resolve({ ready: true })) as AssistantService["status"],
    timeline: record("timeline", []) as AssistantService["timeline"],
    open: record(
      "open",
      Promise.resolve({ conversationId: "c1", origin: "created", options: [] }),
    ) as AssistantService["open"],
    prompt: record(
      "prompt",
      Promise.resolve({ stopReason: "end_turn", reason: null, detail: null }),
    ) as AssistantService["prompt"],
    cancel: record("cancel", undefined) as AssistantService["cancel"],
    close: record("close", Promise.resolve()) as AssistantService["close"],
    setOption: record("setOption", Promise.resolve([])) as AssistantService["setOption"],
    decide: record("decide", undefined) as AssistantService["decide"],
    ...overrides,
  };
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  const handle: GuardedHandle = (channel, handler) => {
    registered.set(channel, handler as unknown as (...args: unknown[]) => unknown);
  };
  registerAssistantHandlers(handle, service, silentMainLog);
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = registered.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return await handler(...args);
  };
  return { invoke, calls, registered, service };
}

describe("registerAssistantHandlers", () => {
  it("registers every channel the bridge invokes", () => {
    const { registered } = harness();
    for (const channel of Object.values(assistantChannels)) {
      expect(registered.has(channel)).toBe(true);
    }
  });
});

describe("conversation ids", () => {
  it("refuses an id shaped like a path, so nothing downstream has to defend against one", async () => {
    const { invoke, calls } = harness();
    await expect(invoke(assistantChannels.assistantOpen, "../../etc")).resolves.toBeNull();
    expect(calls.open).toBeUndefined();
  });

  it("refuses a non-string id", async () => {
    const { invoke } = harness();
    await expect(invoke(assistantChannels.assistantOpen, 7)).resolves.toBeNull();
    await expect(invoke(assistantChannels.assistantCancel, null)).resolves.toBe(false);
    await expect(invoke(assistantChannels.assistantClose, { id: "x" })).resolves.toBe(false);
  });

  it("answers an unknown id with an empty timeline rather than throwing", async () => {
    const { invoke } = harness();
    await expect(invoke(assistantChannels.assistantTimeline, "!!")).resolves.toEqual([]);
  });

  it("accepts a plain id", async () => {
    const { invoke, calls } = harness();
    await invoke(assistantChannels.assistantOpen, "conv_1-abc");
    expect(calls.open?.[0]?.[0]).toBe("conv_1-abc");
  });
});

describe("open", () => {
  it("ignores a relative workspace root from the renderer", async () => {
    // A root from page script would otherwise point the agent's shell wherever the page liked.
    const { invoke, calls } = harness();
    await invoke(assistantChannels.assistantOpen, "c1", "../../..");
    expect(calls.open?.[0]?.[1]).toBeUndefined();
  });

  it("passes an absolute root through", async () => {
    const { invoke, calls } = harness();
    await invoke(assistantChannels.assistantOpen, "c1", "/Users/someone/code");
    expect(calls.open?.[0]?.[1]).toBe("/Users/someone/code");
  });
});

describe("prompt", () => {
  it("refuses an empty message without troubling the harness", async () => {
    const { invoke, calls } = harness();
    await expect(invoke(assistantChannels.assistantPrompt, "c1", "   ")).resolves.toMatchObject({
      stopReason: null,
      reason: "provider_failed",
    });
    expect(calls.prompt).toBeUndefined();
  });

  it("refuses an absurdly long message", async () => {
    const { invoke, calls } = harness();
    await expect(
      invoke(assistantChannels.assistantPrompt, "c1", "x".repeat(200_001)),
    ).resolves.toMatchObject({ reason: "provider_failed" });
    expect(calls.prompt).toBeUndefined();
  });

  it("turns a typed failure into the answer the renderer renders", async () => {
    // The renderer must not have to parse a message to learn there is no key.
    const { invoke } = harness({
      prompt: vi.fn(async () => {
        throw new AssistantUnavailable("key_required", null);
      }),
    });
    await expect(invoke(assistantChannels.assistantPrompt, "c1", "hi")).resolves.toEqual({
      stopReason: null,
      reason: "key_required",
      detail: null,
    });
  });

  it("does not let an unexpected error escape as a rejection", async () => {
    const { invoke } = harness({
      prompt: vi.fn(async () => {
        throw new Error("something with a stack trace in it");
      }),
    });
    await expect(invoke(assistantChannels.assistantPrompt, "c1", "hi")).resolves.toEqual({
      stopReason: null,
      reason: "provider_failed",
      detail: null,
    });
  });
});

describe("setOption", () => {
  it("refuses a non-string config id or value", async () => {
    const { invoke, calls } = harness();
    await expect(invoke(assistantChannels.assistantSetOption, "c1", 1, "x")).resolves.toEqual([]);
    await expect(invoke(assistantChannels.assistantSetOption, "c1", "model", 2)).resolves.toEqual(
      [],
    );
    expect(calls.setOption).toBeUndefined();
  });

  it("answers an empty set when the harness refuses, rather than rejecting", async () => {
    const { invoke } = harness({
      setOption: vi.fn(async () => {
        throw new AssistantUnavailable("boot_failed", "gone");
      }),
    });
    await expect(invoke(assistantChannels.assistantSetOption, "c1", "model", "x")).resolves.toEqual(
      [],
    );
  });
});

describe("decide", () => {
  it("accepts null as an answer, because that is how the renderer says cancelled", async () => {
    const { invoke, calls } = harness();
    await expect(invoke(assistantChannels.assistantDecide, "req-1", null)).resolves.toBe(true);
    expect(calls.decide?.[0]).toEqual(["req-1", null]);
  });

  it("refuses an option id that is neither a string nor null", async () => {
    const { invoke, calls } = harness();
    await expect(invoke(assistantChannels.assistantDecide, "req-1", 5)).resolves.toBe(false);
    await expect(invoke(assistantChannels.assistantDecide, "", "allow")).resolves.toBe(false);
    expect(calls.decide).toBeUndefined();
  });
});
