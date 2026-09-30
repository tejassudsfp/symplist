/**
 * The ACP client side of the bridge: one `ClientSideConnection` over a child process's stdio.
 *
 * Electron's main process is the client, and in ACP the client owns the interesting half — sessions,
 * tools, model selection and permissions. That is the whole reason note 18 chose ACP over embedding
 * dsh: Symplist keeps its storage, its approvals and its tools, and the harness supplies the loop,
 * the compaction and the shell.
 *
 * What this module does *not* do is as deliberate as what it does. It does not persist a session
 * anywhere dsh can see, and it does not answer `session/request_permission` itself — that request is
 * handed up to the renderer, which draws Symplist's own approval card. Delegating either would
 * import dsh's session store or its permission model, and both collide with guarantees the product
 * keeps.
 *
 * It is also not a stream. `prompt` resolves when the turn ends, because that is when
 * `session/prompt` settles; everything during the turn arrives through the `Client` callbacks.
 */
import { Readable, Writable } from "node:stream";
import type {
  Agent,
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AssistantStopReason } from "../../shared/assistant.ts";

/** The identity this client announces at `initialize`. */
const CLIENT_INFO = { name: "symplist-desktop", version: "1" } as const;

/** The two stdio halves of the harness child, narrowed to what a connection needs. */
export interface AcpTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
}

/** What the connection hands back to its owner as the agent works. */
export interface AcpHandlers {
  /** One `session/update`. Serialized per session by the agent, so ordering is already right. */
  readonly onUpdate: (notification: SessionNotification) => void;
  /**
   * A permission request the agent is blocked on. Returning `null` answers `cancelled`, which is
   * what ACP requires when the client cancels the turn rather than deciding.
   */
  readonly onPermission: (request: RequestPermissionRequest) => Promise<string | null>;
}

/**
 * The agent calls this bridge makes.
 *
 * ACP marks `session/list`, `session/resume`, `session/close` and `session/set_config_option`
 * optional on `Agent`, because an agent may not implement them — and `dsh-acp` implements all four,
 * advertising them in `initialize`. Narrowing to a type where they are required is what lets the
 * supervisor call them without a null check per call site; `connectAcp` checks the advertisement, and
 * `canResume` is the answer it keeps.
 */
export type AcpAgent = Pick<Agent, "initialize" | "newSession" | "prompt" | "cancel"> &
  Required<
    Pick<Agent, "listSessions" | "resumeSession" | "closeSession" | "setSessionConfigOption">
  >;

/** An `Agent` proxy plus the capabilities its `initialize` admitted. */
export interface AcpConnection {
  readonly agent: AcpAgent;
  /** Whether the agent will accept `session/resume`, which decides whether a restart can rejoin. */
  readonly canResume: boolean;
  /** Whether the agent will accept an HTTP MCP server, which is how Symplist's tools attach. */
  readonly canAttachHttpMcp: boolean;
}

/**
 * Open a connection on a child's stdio and negotiate capabilities.
 *
 * The capabilities advertised here are the truthful minimum. `fs` is empty and `terminal` is false
 * because the harness has its own filesystem and shell inside its sandbox — offering ours would ask
 * the agent to route file writes back through Electron for no gain, and dsh does not need it.
 * `session.configOptions` is advertised because the model picker is built from the option state, and
 * an agent that is not told the client understands options has no reason to publish them.
 */
export async function connectAcp(
  transport: AcpTransport,
  handlers: AcpHandlers,
): Promise<AcpConnection> {
  const client: Client = {
    sessionUpdate: (notification: SessionNotification): void => {
      handlers.onUpdate(notification);
    },
    requestPermission: async (
      request: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      const optionId = await handlers.onPermission(request);
      if (optionId === null) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    },
  };

  const stream = ndJsonStream(
    Writable.toWeb(transport.stdin as Writable),
    Readable.toWeb(transport.stdout as Readable) as ReadableStream<Uint8Array>,
  );
  const agent = new ClientSideConnection(() => client, stream);

  const initialized = await agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {},
      terminal: false,
      session: { configOptions: {} },
    },
    clientInfo: CLIENT_INFO,
  });

  const capabilities = initialized.agentCapabilities;
  return {
    agent,
    canResume: capabilities?.sessionCapabilities?.resume !== undefined,
    canAttachHttpMcp: capabilities?.mcpCapabilities?.http === true,
  };
}

/**
 * Where Symplist's tools come from, as far as this lane is concerned.
 *
 * The entry itself is built by `src/main/mcp/acp.ts`, which points it at a loopback relay carrying a
 * per-launch capability token and adds the `sym_…` bearer one hop later, inside this process. That is
 * a stronger arrangement than putting the grant key in these headers, and it matters precisely
 * because the payload crosses stdio to a process that runs a shell: `assertNoBearer` there refuses
 * the tempting simplification. Nothing in this file constructs an MCP entry, so nothing here can
 * undo it.
 *
 * It throws when the relay is not running — `dsh-acp` mounts MCP servers with `failOnStartupError`,
 * so a session built against a dead one refuses to start at all — and the supervisor treats that as
 * "no tools this session" rather than "no assistant".
 */
export interface HarnessToolSource {
  mcpServer(): {
    readonly type: "http";
    readonly name: string;
    readonly url: string;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
  };
}

/** ACP's stop reasons are already the vocabulary the renderer wants; this pins the mapping. */
export function toStopReason(stopReason: string): AssistantStopReason {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return stopReason;
    default:
      // A stop reason a newer agent invented still ended the turn; treating it as a refusal is the
      // honest fallback, because the one thing it certainly was not is a completed answer.
      return "refusal";
  }
}
