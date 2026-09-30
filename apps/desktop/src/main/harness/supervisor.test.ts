/**
 * The supervisor, driven against a fake child and a fake ACP agent.
 *
 * Nothing here spawns a process or writes a harness profile into a real `userData` — `spawn`,
 * `connect` and `locate` are all injected, and the profile writer is the one piece that does touch
 * disk, so each test gives it a temporary directory.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantEvent } from "../../shared/assistant.ts";
import { silentMainLog } from "../log.ts";
import type { AcpConnection, AcpTransport } from "./acp-client.ts";
import type { HarnessChild, HarnessSpawnSpec, SupervisorOptions } from "./supervisor.ts";
import { AssistantUnavailable, HarnessSupervisor } from "./supervisor.ts";

interface Fake {
  readonly supervisor: HarnessSupervisor;
  readonly events: AssistantEvent[];
  readonly spawns: HarnessSpawnSpec[];
  readonly agent: FakeAgent;
  readonly children: FakeChild[];
  readonly handlers: { current: Parameters<NonNullable<SupervisorOptions["connect"]>>[1] | null };
}

class FakeChild implements HarnessChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4_242;
  killed: NodeJS.Signals | "default" | null = null;
  private exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? "default";
    // A real process exits on SIGTERM, and the supervisor's escalation timer is the only other way
    // out of `stop()`. A fake that never exits would make every teardown wait that timer out.
    this.exit(0);
    return true;
  }
  once(_event: "exit", listener: (code: number | null, signal: string | null) => void): unknown {
    this.exitListeners.push(listener);
    return this;
  }
  exit(code: number): void {
    const listeners = this.exitListeners;
    this.exitListeners = [];
    for (const listener of listeners) listener(code, null);
  }
}

class FakeAgent {
  newSessionCalls: { cwd: string; mcpServers: unknown[] }[] = [];
  resumeCalls: { sessionId: string; cwd: string }[] = [];
  closed: string[] = [];
  cancelled: string[] = [];
  listed: { sessionId: string; cwd: string }[] = [];
  promptResult: { stopReason: string } | Error = { stopReason: "end_turn" };
  nextSessionId = "s1";

  initialize = vi.fn();
  newSession = vi.fn(async (params: { cwd: string; mcpServers: unknown[] }) => {
    this.newSessionCalls.push(params);
    return {
      sessionId: this.nextSessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          currentValue: '["openai","gpt-5"]',
          options: [{ value: '["openai","gpt-5"]', name: "GPT-5" }],
        },
      ],
    };
  });
  listSessions = vi.fn(async (_params: { cwd?: string | null }) => ({ sessions: this.listed }));
  resumeSession = vi.fn(async (params: { sessionId: string; cwd: string }) => {
    this.resumeCalls.push(params);
    return { configOptions: [] };
  });
  closeSession = vi.fn(async (params: { sessionId: string }) => {
    this.closed.push(params.sessionId);
    return {};
  });
  /** Replaced per test; declared apart from the mock so a richer option set still type-checks. */
  configOptions: SessionConfigOption[] = [];
  setSessionConfigOption = vi.fn(async () => ({ configOptions: this.configOptions }));
  prompt = vi.fn(async () => {
    if (this.promptResult instanceof Error) throw this.promptResult;
    return this.promptResult;
  });
  cancel = vi.fn(async (params: { sessionId: string }) => {
    this.cancelled.push(params.sessionId);
  });
}

let userData = "";

/**
 * The first item, or a failure naming what was expected. `noUncheckedIndexedAccess` is on, and an
 * assertion operator here would turn "the supervisor never spawned" into an unhelpful crash inside a
 * property read.
 */
function only<T>(items: readonly T[], what: string): T {
  const value = items[0];
  if (value === undefined) throw new Error(`expected at least one ${what}`);
  return value;
}

async function fake(overrides: Partial<SupervisorOptions> = {}): Promise<Fake> {
  const events: AssistantEvent[] = [];
  const spawns: HarnessSpawnSpec[] = [];
  const children: FakeChild[] = [];
  const agent = new FakeAgent();
  const handlers: Fake["handlers"] = { current: null };
  const supervisor = new HarnessSupervisor({
    workspaceRoot: "/workspace",
    userData,
    keyring: { providerKeys: async () => ({ openai: "sk-test-value" }) },
    tools: {
      mcpServer: () => ({
        type: "http",
        name: "symplist",
        url: "http://127.0.0.1:1234/mcp",
        headers: [{ name: "X-Symplist-Relay", value: "cap" }],
      }),
    },
    log: silentMainLog,
    emit: (event) => events.push(event),
    locate: () => ({ root: "/harness", launcher: "/harness/launch-acp.mjs" }),
    spawn: (spec) => {
      spawns.push(spec);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    connect: async (_transport: AcpTransport, given): Promise<AcpConnection> => {
      handlers.current = given;
      return {
        agent: agent as unknown as AcpConnection["agent"],
        canResume: true,
        canAttachHttpMcp: true,
      };
    },
    now: () => 1_000,
    ...overrides,
  });
  return { supervisor, events, spawns, agent, children, handlers };
}

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "symplist-harness-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("status", () => {
  it("reports a missing harness rather than pretending it is ready", async () => {
    const { supervisor } = await fake({ locate: () => null });
    expect(supervisor.available()).toBe(false);
    await expect(supervisor.status()).resolves.toMatchObject({
      ready: false,
      reason: "harness_missing",
    });
  });

  it("reports key_required when the device holds no provider key", async () => {
    const { supervisor } = await fake({ keyring: { providerKeys: async () => ({}) } });
    // Availability is about the runtime, not readiness: the chat slot still mounts, because chat is
    // where the "add a key" state belongs.
    expect(supervisor.available()).toBe(true);
    await expect(supervisor.status()).resolves.toMatchObject({
      ready: false,
      reason: "key_required",
      providerKeys: { openai: false, anthropic: false },
    });
  });

  it("names which keys exist without carrying their values", async () => {
    const { supervisor } = await fake();
    const status = await supervisor.status();
    expect(status).toMatchObject({ ready: true, providerKeys: { openai: true, anthropic: false } });
    expect(JSON.stringify(status)).not.toContain("sk-test-value");
  });

  it("survives a keychain that throws", async () => {
    const { supervisor } = await fake({
      keyring: {
        providerKeys: async () => {
          throw new Error("keychain locked");
        },
      },
    });
    await expect(supervisor.status()).resolves.toMatchObject({ reason: "key_required" });
  });
});

describe("open", () => {
  it("spawns one child under Electron's Node with the key in its environment", async () => {
    const { supervisor, spawns } = await fake();
    await supervisor.open("conv1");
    expect(spawns).toHaveLength(1);
    expect(only(spawns, "spawn")).toMatchObject({
      launcher: "/harness/launch-acp.mjs",
      cwd: "/workspace",
    });
    expect(only(spawns, "spawn").env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(only(spawns, "spawn").env.SYMPLIST_OPENAI_API_KEY).toBe("sk-test-value");
    expect(only(spawns, "spawn").env.DSH_TELEMETRY_DISABLED).toBe("1");
    await supervisor.dispose();
  });

  it("restart drops the children but leaves the supervisor able to spawn again", async () => {
    // Adding a provider key calls this. A key reaches a child in its environment at spawn time, so the
    // child has to be replaced — but `dispose` would end the assistant for the rest of the run, and the
    // user would have added a key only to find chat permanently dead until they relaunched.
    const { supervisor, spawns, children } = await fake();
    await supervisor.open("conv1");
    expect(spawns).toHaveLength(1);
    await supervisor.restart();
    expect(children[0]?.killed).toBeTruthy();
    await supervisor.open("conv1");
    expect(spawns).toHaveLength(2);
    await supervisor.dispose();
  });

  it("dispose is final, so nothing spawns after quit begins", async () => {
    const { supervisor, spawns } = await fake();
    await supervisor.open("conv1");
    await supervisor.dispose();
    await expect(supervisor.open("conv1")).rejects.toBeInstanceOf(AssistantUnavailable);
    expect(spawns).toHaveLength(1);
  });

  it("does not inherit the ambient environment wholesale", async () => {
    // The agent has a shell and can read its own environment, so anything inherited is something the
    // agent can see. The curated list is the boundary.
    process.env.SYMPLIST_TEST_LEAK = "leaked";
    try {
      const { supervisor, spawns } = await fake();
      await supervisor.open("conv1");
      expect(only(spawns, "spawn").env.SYMPLIST_TEST_LEAK).toBeUndefined();
      await supervisor.dispose();
    } finally {
      delete process.env.SYMPLIST_TEST_LEAK;
    }
  });

  it("writes the generated profile before spawning, with only the route that has a key", async () => {
    const { supervisor, spawns } = await fake();
    await supervisor.open("conv1");
    const patch = await readFile(
      join(String(only(spawns, "spawn").env.SYMPLIST_DSH_PROFILE), "cordis.patch.yml"),
      "utf8",
    );
    expect(patch).toContain("apiKeyEnv: SYMPLIST_OPENAI_API_KEY");
    expect(patch).not.toContain("SYMPLIST_ANTHROPIC_API_KEY");
    // The key itself must never reach a file, which is the whole reason `apiKeyEnv` is a reference.
    expect(patch).not.toContain("sk-test-value");
    await supervisor.dispose();
  });

  it("refuses to spawn at all when there is no key", async () => {
    const { supervisor, spawns } = await fake({ keyring: { providerKeys: async () => ({}) } });
    await expect(supervisor.open("conv1")).rejects.toBeInstanceOf(AssistantUnavailable);
    // A child with no route would boot, advertise nothing, and fail the first turn with a provider
    // error instead of the one thing the user can fix.
    expect(spawns).toHaveLength(0);
  });

  it("attaches the loopback MCP entry, carrying no bearer across stdio", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    expect(only(agent.newSessionCalls, "session").mcpServers).toEqual([
      {
        type: "http",
        name: "symplist",
        url: "http://127.0.0.1:1234/mcp",
        headers: [{ name: "X-Symplist-Relay", value: "cap" }],
      },
    ]);
    await supervisor.dispose();
  });

  it("still opens when the relay is down, with a shell and no workspace tools", async () => {
    const { supervisor, agent } = await fake({
      tools: {
        mcpServer: () => {
          throw new Error("symplist mcp: the relay is not running");
        },
      },
    });
    await supervisor.open("conv1");
    expect(only(agent.newSessionCalls, "session").mcpServers).toEqual([]);
    await supervisor.dispose();
  });

  it("shares one child between two conversations on the same root", async () => {
    const { supervisor, spawns, agent } = await fake();
    agent.nextSessionId = "s1";
    await supervisor.open("conv1");
    agent.nextSessionId = "s2";
    await supervisor.open("conv2");
    expect(spawns).toHaveLength(1);
    await supervisor.dispose();
  });

  it("shares one child between concurrent opens rather than spawning twice", async () => {
    const { supervisor, spawns, agent } = await fake();
    let n = 0;
    agent.newSession = vi.fn(async (params: { cwd: string; mcpServers: unknown[] }) => {
      n += 1;
      agent.newSessionCalls.push(params);
      return { sessionId: `s${n}`, configOptions: [] };
    });
    await Promise.all([supervisor.open("a"), supervisor.open("b")]);
    expect(spawns).toHaveLength(1);
    await supervisor.dispose();
  });

  it("reuses an already-open conversation without a second session", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    await expect(supervisor.open("conv1")).resolves.toMatchObject({ origin: "reused" });
    expect(agent.newSession).toHaveBeenCalledTimes(1);
    await supervisor.dispose();
  });

  it("surfaces a boot failure as a real state carrying the harness's own line", async () => {
    const { supervisor } = await fake({
      connect: async () => {
        throw new Error("symplist: plugin tree failed to load: acp-app-startup");
      },
    });
    await expect(supervisor.open("conv1")).rejects.toMatchObject({ reason: "boot_failed" });
    await expect(supervisor.status()).resolves.toMatchObject({
      ready: false,
      reason: "boot_failed",
      detail: expect.stringContaining("plugin tree failed to load"),
    });
  });
});

describe("resume", () => {
  const book = (stored: string | null) => {
    const state = { value: stored, forgotten: false, written: null as string | null };
    return {
      state,
      book: {
        get: async () => state.value,
        set: async (_id: string, sessionId: string) => {
          state.written = sessionId;
        },
        forget: async () => {
          state.forgotten = true;
        },
      },
    };
  };

  it("rejoins the session the agent still holds", async () => {
    const { state, book: sessionBook } = book("old-session");
    const { supervisor, agent } = await fake({ sessionBook });
    agent.listed = [{ sessionId: "old-session", cwd: "/workspace" }];
    await expect(supervisor.open("conv1")).resolves.toMatchObject({ origin: "resumed" });
    expect(only(agent.resumeCalls, "resume")).toMatchObject({
      sessionId: "old-session",
      cwd: "/workspace",
    });
    expect(state.forgotten).toBe(false);
    await supervisor.dispose();
  });

  it("re-mounts the MCP entry on resume, because resume does not restore the old ones", async () => {
    const { book: sessionBook } = book("old-session");
    const { supervisor, agent } = await fake({ sessionBook });
    agent.listed = [{ sessionId: "old-session", cwd: "/workspace" }];
    await supervisor.open("conv1");
    expect(agent.resumeSession.mock.calls[0]?.[0]).toMatchObject({
      mcpServers: [{ url: "http://127.0.0.1:1234/mcp" }],
    });
    await supervisor.dispose();
  });

  it("creates a fresh session and forgets the id when the agent has aged it out", async () => {
    const { state, book: sessionBook } = book("gone");
    const { supervisor, agent } = await fake({ sessionBook });
    agent.listed = [];
    await expect(supervisor.open("conv1")).resolves.toMatchObject({ origin: "created" });
    expect(state.forgotten).toBe(true);
    expect(state.written).toBe("s1");
    await supervisor.dispose();
  });

  it("falls back to a fresh session when resume itself fails", async () => {
    const { state, book: sessionBook } = book("old-session");
    const { supervisor, agent } = await fake({ sessionBook });
    agent.listed = [{ sessionId: "old-session", cwd: "/workspace" }];
    agent.resumeSession = vi.fn(async () => {
      throw new Error("workspace mismatch");
    });
    await expect(supervisor.open("conv1")).resolves.toMatchObject({ origin: "created" });
    // Left pointing at it, every launch would retry the same failure before falling back.
    expect(state.forgotten).toBe(true);
    await supervisor.dispose();
  });

  it("does not try to resume when the agent does not advertise it", async () => {
    const { book: sessionBook } = book("old-session");
    const agent = new FakeAgent();
    const { supervisor } = await fake({
      sessionBook,
      connect: async () => ({
        agent: agent as unknown as AcpConnection["agent"],
        canResume: false,
        canAttachHttpMcp: true,
      }),
    });
    await expect(supervisor.open("conv1")).resolves.toMatchObject({ origin: "created" });
    expect(agent.listSessions).not.toHaveBeenCalled();
    await supervisor.dispose();
  });
});

describe("prompt", () => {
  it("echoes the user's message, then records the turn's stop reason", async () => {
    const { supervisor, events } = await fake();
    await supervisor.open("conv1");
    await expect(supervisor.prompt("conv1", "run ls")).resolves.toEqual({
      stopReason: "end_turn",
      reason: null,
      detail: null,
    });
    const kinds = events
      .filter((event) => event.type === "timeline")
      .map((event) => (event.type === "timeline" ? event.entry.kind : ""));
    expect(kinds).toEqual(["user", "turn"]);
    await supervisor.dispose();
  });

  it("classifies a rejected key as key_required, not as a generic provider failure", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    agent.promptResult = new Error(
      'turn failed: OpenAI API error (401): {"code":"invalid_api_key"}',
    );
    // The distinction is the whole point: this offers the way to Settings → Models instead of a Retry
    // that can only fail again.
    await expect(supervisor.prompt("conv1", "hi")).resolves.toMatchObject({
      reason: "key_required",
    });
    await supervisor.dispose();
  });

  it("classifies an unresolved apiKeyEnv reference as key_required", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    agent.promptResult = new Error("MISSING_CREDENTIAL: route openai reference");
    await expect(supervisor.prompt("conv1", "hi")).resolves.toMatchObject({
      reason: "key_required",
    });
    await supervisor.dispose();
  });

  it("classifies anything else as provider_failed, which a retry may fix", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    agent.promptResult = new Error("upstream connect timeout");
    await expect(supervisor.prompt("conv1", "hi")).resolves.toMatchObject({
      reason: "provider_failed",
    });
    await supervisor.dispose();
  });

  it("redacts a failure that echoed a credential back", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    agent.promptResult = new Error("request failed with authorization: Bearer sym_abcdefghij");
    const result = await supervisor.prompt("conv1", "hi");
    expect(result.detail).not.toContain("sym_abcdefghij");
    await supervisor.dispose();
  });

  it("refuses a conversation that is not open", async () => {
    const { supervisor } = await fake();
    await expect(supervisor.prompt("nope", "hi")).rejects.toBeInstanceOf(AssistantUnavailable);
  });

  it("reports the child being gone rather than hanging", async () => {
    const { supervisor, children } = await fake();
    await supervisor.open("conv1");
    only(children, "child").exit(1);
    await expect(supervisor.prompt("conv1", "hi")).rejects.toBeInstanceOf(AssistantUnavailable);
  });
});

describe("updates and approvals", () => {
  it("routes a session update to the conversation that owns the session", async () => {
    const { supervisor, events, handlers } = await fake();
    await supervisor.open("conv1");
    handlers.current?.onUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        messageId: "m1",
      },
    });
    expect(events.at(-1)).toEqual({
      type: "timeline",
      conversationId: "conv1",
      entry: { kind: "message", id: "m1", at: 1_000, text: "hello" },
    });
    expect(supervisor.timeline("conv1")).toHaveLength(1);
    await supervisor.dispose();
  });

  it("drops an update for a session it does not own", async () => {
    const { supervisor, events, handlers } = await fake();
    await supervisor.open("conv1");
    const before = events.length;
    handlers.current?.onUpdate({
      sessionId: "someone-else",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
    });
    expect(events).toHaveLength(before);
    await supervisor.dispose();
  });

  it("keeps a tool call as one entry across its lifecycle", async () => {
    const { supervisor, handlers } = await fake();
    await supervisor.open("conv1");
    handlers.current?.onUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Update section",
        status: "pending",
      },
    });
    handlers.current?.onUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    });
    const timeline = supervisor.timeline("conv1");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "tool", status: "completed" });
    await supervisor.dispose();
  });

  it("hands a permission request to the renderer and returns the chosen option", async () => {
    const { supervisor, events, handlers } = await fake();
    await supervisor.open("conv1");
    const pending = handlers.current?.onPermission({
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Run rm -rf", name: "bash" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const approval = events.find((event) => event.type === "approval");
    expect(approval).toMatchObject({
      type: "approval",
      approval: { conversationId: "conv1", title: "Run rm -rf", name: "bash" },
    });
    if (approval?.type !== "approval") throw new Error("no approval event");
    supervisor.decide(approval.approval.requestId, "reject");
    await expect(pending).resolves.toBe("reject");
    await supervisor.dispose();
  });

  it("answers cancelled when a cancellation releases a blocked approval", async () => {
    // ACP requires a cancelled turn to answer its permission request with `cancelled`; left unanswered
    // the agent waits forever and the cancellation never reaches a terminal state.
    const { supervisor, handlers } = await fake();
    await supervisor.open("conv1");
    const pending = handlers.current?.onPermission({
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    supervisor.cancel("conv1");
    await expect(pending).resolves.toBeNull();
    await supervisor.dispose();
  });

  it("sends session/cancel for the right session", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    supervisor.cancel("conv1");
    expect(agent.cancelled).toEqual(["s1"]);
    await supervisor.dispose();
  });
});

describe("options", () => {
  it("replaces the whole option set from the response, not just the changed one", async () => {
    const { supervisor, agent, events } = await fake();
    await supervisor.open("conv1");
    agent.configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: '["openai","gpt-5.2"]',
        options: [{ value: '["openai","gpt-5.2"]', name: "GPT-5.2" }],
      },
    ];
    const options = await supervisor.setOption("conv1", "model", '["openai","gpt-5.2"]');
    expect(only(options, "option").currentValue).toBe('["openai","gpt-5.2"]');
    expect(events.some((event) => event.type === "options")).toBe(true);
    await supervisor.dispose();
  });
});

describe("close and dispose", () => {
  it("closes the ACP session and forgets the conversation", async () => {
    const { supervisor, agent } = await fake();
    await supervisor.open("conv1");
    await supervisor.close("conv1");
    expect(agent.closed).toEqual(["s1"]);
    expect(supervisor.timeline("conv1")).toEqual([]);
    await supervisor.dispose();
  });

  it("ends stdin before signalling, because dsh binds stdin EOF to a bounded shutdown", async () => {
    const { supervisor, children } = await fake();
    await supervisor.open("conv1");
    const child = only(children, "child");
    const ended = vi.spyOn(child.stdin, "end");
    const disposing = supervisor.dispose();
    child.exit(0);
    await disposing;
    expect(ended).toHaveBeenCalled();
    expect(child.killed).toBe("SIGTERM");
  });

  it("refuses to open anything after dispose", async () => {
    const { supervisor } = await fake();
    await supervisor.dispose();
    await expect(supervisor.open("conv1")).rejects.toBeInstanceOf(AssistantUnavailable);
  });

  it("forgets a conversation whose child exited on its own", async () => {
    const { supervisor, children } = await fake();
    await supervisor.open("conv1");
    only(children, "child").exit(1);
    expect(supervisor.timeline("conv1")).toEqual([]);
  });
});
