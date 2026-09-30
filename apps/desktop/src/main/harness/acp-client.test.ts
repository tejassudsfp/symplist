/**
 * The ACP client against a real agent on the other end of a real pair of pipes.
 *
 * The SDK's own `AgentSideConnection` plays the agent, so the frames on the wire are the frames dsh
 * would see: this exercises the JSON-RPC framing, the method names, the capability negotiation and
 * the direction of `session/request_permission`, none of which a hand-stubbed connection would.
 */

import { PassThrough, Readable, Writable } from "node:stream";
import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import { AgentSideConnection as AgentConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { connectAcp, toStopReason } from "./acp-client.ts";

/** What the fake agent was asked for, so the client's own requests can be asserted. */
interface AgentState {
  initialize?: unknown;
  newSession?: unknown;
}

/** A minimal agent: the four calls the bridge makes, plus the two it provokes. */
function startAgent(
  toClient: PassThrough,
  fromClient: PassThrough,
  state: AgentState,
  behaviour: {
    readonly onPrompt?: (connection: AgentSideConnection, sessionId: string) => Promise<void>;
  } = {},
): void {
  new AgentConnection(
    (connection): Agent => ({
      initialize: async (params) => {
        state.initialize = params;
        return {
          protocolVersion: params.protocolVersion,
          agentInfo: { name: "fake-dsh", version: "0" },
          agentCapabilities: {
            mcpCapabilities: { http: true },
            sessionCapabilities: { close: {}, list: {}, resume: {} },
          },
        };
      },
      newSession: async (params) => {
        state.newSession = params;
        return {
          sessionId: "s1",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: '["openai","gpt-5"]',
              options: [{ value: '["openai","gpt-5"]', name: "GPT-5" }],
            },
          ],
        };
      },
      prompt: async (params) => {
        await behaviour.onPrompt?.(connection, params.sessionId);
        return { stopReason: "end_turn" };
      },
      cancel: async () => undefined,
      // Required by the `Agent` interface; dsh answers it with immediate success, because the ACP
      // server requires no authentication of its own — the client is a trusted controller.
      authenticate: async () => ({}),
    }),
    ndJsonStream(
      Writable.toWeb(toClient) as WritableStream<Uint8Array>,
      Readable.toWeb(fromClient) as ReadableStream<Uint8Array>,
    ),
  );
}

/**
 * One connected pair. `client` is what `connectAcp` treats as a child's stdio; the agent writes to
 * the stream the client reads and reads the one the client writes.
 */
function pipes(): {
  client: { stdin: PassThrough; stdout: PassThrough };
  toClient: PassThrough;
  fromClient: PassThrough;
} {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  return {
    client: { stdin: clientToAgent, stdout: agentToClient },
    toClient: agentToClient,
    fromClient: clientToAgent,
  };
}

describe("connectAcp", () => {
  it("negotiates and reports the capabilities that decide what the bridge may do", async () => {
    const { client, toClient, fromClient } = pipes();
    const state: AgentState = {};
    startAgent(toClient, fromClient, state);
    const connection = await connectAcp(client, {
      onUpdate: () => undefined,
      onPermission: async () => null,
    });
    expect(connection.canResume).toBe(true);
    expect(connection.canAttachHttpMcp).toBe(true);
  });

  it("advertises no terminal and an empty filesystem, because the harness has its own", async () => {
    const { client, toClient, fromClient } = pipes();
    const state: AgentState = {};
    startAgent(toClient, fromClient, state);
    await connectAcp(client, { onUpdate: () => undefined, onPermission: async () => null });
    expect(state.initialize).toMatchObject({
      clientCapabilities: { terminal: false, session: { configOptions: {} } },
      clientInfo: { name: "symplist-desktop" },
    });
  });

  it("carries the MCP entry to session/new verbatim", async () => {
    const { client, toClient, fromClient } = pipes();
    const state: AgentState = {};
    startAgent(toClient, fromClient, state);
    const connection = await connectAcp(client, {
      onUpdate: () => undefined,
      onPermission: async () => null,
    });
    await connection.agent.newSession({
      cwd: "/workspace",
      mcpServers: [
        {
          type: "http",
          name: "symplist",
          url: "http://127.0.0.1:9/mcp",
          headers: [{ name: "X-Symplist-Relay", value: "cap" }],
        },
      ],
    });
    expect(state.newSession).toMatchObject({
      cwd: "/workspace",
      mcpServers: [{ name: "symplist", url: "http://127.0.0.1:9/mcp" }],
    });
  });

  it("delivers session updates to the handler during a turn", async () => {
    const { client, toClient, fromClient } = pipes();
    startAgent(
      toClient,
      fromClient,
      {},
      {
        onPrompt: async (connection, sessionId) => {
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello" },
            },
          });
        },
      },
    );
    const seen: string[] = [];
    const connection = await connectAcp(client, {
      onUpdate: (notification) => seen.push(notification.update.sessionUpdate),
      onPermission: async () => null,
    });
    const session = await connection.agent.newSession({ cwd: "/workspace", mcpServers: [] });
    const result = await connection.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(seen).toContain("agent_message_chunk");
  });

  it("answers a permission request with the option the handler chose", async () => {
    const { client, toClient, fromClient } = pipes();
    let outcome: unknown;
    startAgent(
      toClient,
      fromClient,
      {},
      {
        onPrompt: async (connection, sessionId) => {
          const response = await connection.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t1", title: "Run ls" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          });
          outcome = response.outcome;
        },
      },
    );
    const connection = await connectAcp(client, {
      onUpdate: () => undefined,
      onPermission: async () => "allow",
    });
    const session = await connection.agent.newSession({ cwd: "/workspace", mcpServers: [] });
    await connection.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("answers cancelled when the handler declines to decide", async () => {
    // ACP requires exactly this when the client cancels the turn rather than choosing an option.
    const { client, toClient, fromClient } = pipes();
    let outcome: unknown;
    startAgent(
      toClient,
      fromClient,
      {},
      {
        onPrompt: async (connection, sessionId) => {
          const response = await connection.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t1", title: "Run ls" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          });
          outcome = response.outcome;
        },
      },
    );
    const connection = await connectAcp(client, {
      onUpdate: () => undefined,
      onPermission: async () => null,
    });
    const session = await connection.agent.newSession({ cwd: "/workspace", mcpServers: [] });
    await connection.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(outcome).toEqual({ outcome: "cancelled" });
  });
});

describe("toStopReason", () => {
  it("passes ACP's own vocabulary through", () => {
    expect(toStopReason("cancelled")).toBe("cancelled");
    expect(toStopReason("max_tokens")).toBe("max_tokens");
  });

  it("treats an unknown reason as a refusal, because it certainly was not a completed answer", () => {
    expect(toStopReason("invented_by_a_newer_agent")).toBe("refusal");
  });
});
