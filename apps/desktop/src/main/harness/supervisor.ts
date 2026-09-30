/**
 * The harness supervisor: the main process's only owner of a dsh child, its ACP connections and the
 * sessions on them.
 *
 * ### Why a child process at all
 *
 * dsh could be imported. It must not be. Three of its behaviours own the process they run in:
 * `dsh-acp`'s `stream` config is labelled "runtime-only transport override; production uses stdio",
 * `dsh-acp-app` claims stdout for protocol frames and binds process lifetime to stdin EOF, and
 * `installFailLoud` exits the process on an unhandled rejection. An Electron main process cannot hand
 * any of those over. Separately, ~230 plugins, worker threads, a pty and a sandbox in the process
 * that owns the window is one crash away from taking the window with it.
 *
 * ### Why one child per workspace root
 *
 * `dsh-base` pins `sandbox-policy.workspaceRoot` and `fs-sandbox` to `process.cwd()` — process-wide —
 * while ACP scopes `cwd` per session. Rather than pretend those agree, the child's cwd *is* the
 * workspace root and every session on it uses the same `cwd`. Children are mapped by root, spawned
 * lazily, and reaped when idle, because each one is a resident Node process with a ~290MB module
 * tree behind it.
 *
 * ### What never happens here
 *
 * No secret is written to a file or a log. Provider keys leave the keyring in exactly one direction —
 * into the child's spawn environment — and the grant key in exactly one — into an MCP header. The
 * child's stderr is free text and is redacted before it is logged, because a harness that echoes a
 * failed request back with its `Authorization` header would otherwise put a bearer token on disk.
 *
 * That said, the honest limit belongs in the code as much as in the product: the key in the child's
 * environment is not behind a boundary. The agent has a shell and runs as the user. The keychain
 * protects the key at rest across restarts; it does not protect it from the agent.
 */
import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  McpServer,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AssistantApproval,
  AssistantEvent,
  AssistantOption,
  AssistantSession,
  AssistantStatus,
  AssistantTimelineEntry,
  AssistantTurnResult,
  AssistantUnavailableReason,
} from "../../shared/assistant.ts";
import type { MainLog } from "../log.ts";
import { redactSecrets } from "../log.ts";
import { nodeRunnerPath } from "../node-runner.ts";
import type { AcpConnection, AcpTransport, HarnessToolSource } from "./acp-client.ts";
import { connectAcp, toStopReason } from "./acp-client.ts";
import type { HarnessLocation } from "./locate.ts";
import { locateHarness } from "./locate.ts";
import type { AssistantProvider } from "./profile.ts";
import { providerKeyEnv } from "./profile.ts";
import { writeHarnessProfile } from "./profile-writer.ts";
import type { ToolCallState } from "./updates.ts";
import { projectUpdate, toAssistantOptions } from "./updates.ts";

/** Environment variable naming an already-vendored harness tree, for development and the spike. */
export const HARNESS_ROOT_ENV = "SYMPLIST_DSH_HARNESS";

/** How long an idle child lives before it is reaped. */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** How many timeline entries one conversation keeps in memory. */
const TIMELINE_LIMIT = 2_000;

/** How much of a child's stderr is kept to explain a boot failure. */
const STDERR_KEEP_BYTES = 8_000;

/**
 * The keychain, as this lane needs it.
 *
 * Defined here rather than imported because the keychain and cloud sign-in land in a parallel lane;
 * whatever implements it, this is the whole surface the supervisor uses. Both methods return values,
 * which is why nothing else in the process may hold a reference to one.
 */
export interface HarnessKeyring {
  /** The provider keys this device holds, by route. Absent means "no key for that provider". */
  providerKeys(): Promise<Partial<Record<AssistantProvider, string>>>;
}

/** The account's model choice, when one has been made. */
export interface HarnessModelPreference {
  readonly provider: AssistantProvider | null;
  readonly model: string | null;
}

/**
 * Where a conversation's ACP session id is remembered across restarts.
 *
 * Defined here, implemented elsewhere: the local transcript store is a parallel lane's file, and this
 * is the whole surface resume needs from it. Without one the supervisor still works — every
 * conversation simply starts a fresh session on relaunch, which loses the agent's context but not
 * the user's transcript.
 */
export interface HarnessSessionBook {
  get(conversationId: string): Promise<string | null>;
  set(conversationId: string, acpSessionId: string): Promise<void>;
  forget(conversationId: string): Promise<void>;
}

/** A spawned child, narrowed to what the supervisor drives. Injected so tests need no process. */
export interface HarnessChild extends AcpTransport {
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
}

/** Everything the supervisor needs to spawn one child. */
export interface HarnessSpawnSpec {
  readonly launcher: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface SupervisorOptions {
  /** The directory the agent's shell and filesystem are scoped to. */
  readonly workspaceRoot: string;
  /** Electron's `userData`; the generated profile and the harness home live under it. */
  readonly userData: string;
  readonly keyring: HarnessKeyring;
  /**
   * Symplist's tools, as the loopback relay in `src/main/mcp/` publishes them. Null in a shell built
   * without it: the agent then has a shell and no workspace access, which is degraded but not broken,
   * and is exactly the state the reconnect banner beside chat is for.
   */
  readonly tools: HarnessToolSource | null;
  readonly log: MainLog;
  /** Pushed to the renderer. The supervisor never touches a `BrowserWindow` itself. */
  readonly emit: (event: AssistantEvent) => void;
  /** The account's model choice; defaults to none, in which case the route's own default is used. */
  readonly modelPreference?: () => Promise<HarnessModelPreference>;
  /** Persisted conversation → ACP session ids, so a relaunch can rejoin instead of starting over. */
  readonly sessionBook?: HarnessSessionBook;
  /** Overridden in tests. */
  readonly locate?: () => HarnessLocation | null;
  readonly spawn?: (spec: HarnessSpawnSpec) => HarnessChild;
  readonly connect?: (
    transport: AcpTransport,
    handlers: Parameters<typeof connectAcp>[1],
  ) => Promise<AcpConnection>;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
}

/** One live child and the connection on it. */
interface HarnessInstance {
  readonly root: string;
  readonly child: HarnessChild;
  readonly connection: AcpConnection;
  /** ACP session ids on this child, so a reap can close them and a resume can find them. */
  readonly sessionIds: Set<string>;
  idleSince: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
}

/** One conversation's live session. */
interface ConversationState {
  readonly conversationId: string;
  readonly workspaceRoot: string;
  readonly acpSessionId: string;
  options: readonly AssistantOption[];
  readonly tools: Map<string, ToolCallState>;
  readonly timeline: AssistantTimelineEntry[];
  /** Set while a turn is in flight, so cancel knows there is something to cancel. */
  inFlight: boolean;
}

/** A failure the renderer can act on, rather than a string to parse. */
export class AssistantUnavailable extends Error {
  constructor(
    readonly reason: AssistantUnavailableReason,
    readonly detail: string | null,
  ) {
    super(`symplist: assistant unavailable (${reason})`);
    this.name = "AssistantUnavailable";
  }
}

export class HarnessSupervisor {
  private readonly options: SupervisorOptions;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly instances = new Map<string, HarnessInstance>();
  private readonly conversations = new Map<string, ConversationState>();
  /** ACP session id → conversation id, because `session/update` is addressed by session. */
  private readonly sessionOwners = new Map<string, string>();
  /** Pending approvals by request id, resolved when the renderer decides. */
  private readonly approvals = new Map<string, (optionId: string | null) => void>();
  /** In-flight spawns, so two conversations opening at once share one child. */
  private readonly starting = new Map<string, Promise<HarnessInstance>>();
  private lastFailure: {
    readonly reason: AssistantUnavailableReason;
    readonly detail: string | null;
  } | null = null;
  private disposed = false;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Whether this build carries a harness at all. `HostInfo.assistant` is this, not readiness: the
   * chat slot mounts on it, and a missing provider key is something chat itself explains and offers
   * a way out of. A shell with no harness shows no chat.
   */
  available(): boolean {
    return this.locate() !== null;
  }

  /** What the renderer shows before anything is opened. */
  async status(): Promise<AssistantStatus> {
    const keys = await this.providerKeys();
    const providerKeys = {
      openai: keys.openai !== undefined,
      anthropic: keys.anthropic !== undefined,
    };
    const base = { providerKeys, workspaceRoot: this.options.workspaceRoot };
    if (this.locate() === null) {
      return {
        ready: false,
        reason: "harness_missing",
        detail: "This build shipped without the assistant runtime.",
        ...base,
      };
    }
    if (!providerKeys.openai && !providerKeys.anthropic) {
      return { ready: false, reason: "key_required", detail: null, ...base };
    }
    if (this.lastFailure !== null) {
      return {
        ready: false,
        reason: this.lastFailure.reason,
        detail: this.lastFailure.detail,
        ...base,
      };
    }
    return { ready: true, reason: null, detail: null, ...base };
  }

  /** The entries a conversation has accumulated, for a renderer that just mounted. */
  timeline(conversationId: string): readonly AssistantTimelineEntry[] {
    return this.conversations.get(conversationId)?.timeline ?? [];
  }

  /**
   * Open a conversation: reuse its session, rejoin a persisted one, or create one.
   *
   * ACP resume does not replay history — `session/resume` "restores the log without replaying old
   * updates" — so a resumed session arrives with an empty timeline as far as this process is
   * concerned. The `origin` in the result says which happened, because that is the difference
   * between a chat that looks empty and a chat that is empty.
   */
  async open(conversationId: string, workspaceRoot?: string): Promise<AssistantSession> {
    const existing = this.conversations.get(conversationId);
    if (existing) return { conversationId, origin: "reused", options: existing.options };

    const root = workspaceRoot ?? this.options.workspaceRoot;
    const instance = await this.instance(root);
    const mcpServers = this.mcpServers();

    const resumed = await this.tryResume(conversationId, root, instance, mcpServers);
    const session =
      resumed ??
      (await (async () => {
        const created = await instance.connection.agent.newSession({ cwd: root, mcpServers });
        await this.options.sessionBook?.set(conversationId, created.sessionId);
        return {
          sessionId: created.sessionId,
          options: toAssistantOptions(created.configOptions),
          origin: "created" as const,
        };
      })());

    const state: ConversationState = {
      conversationId,
      workspaceRoot: root,
      acpSessionId: session.sessionId,
      options: session.options,
      tools: new Map(),
      timeline: [],
      inFlight: false,
    };
    this.conversations.set(conversationId, state);
    this.sessionOwners.set(session.sessionId, conversationId);
    instance.sessionIds.add(session.sessionId);
    this.markBusy(instance);
    this.options.log.info("assistant.session_opened", {
      conversationId,
      origin: session.origin,
      options: state.options.length,
    });
    return { conversationId, origin: session.origin, options: state.options };
  }

  /**
   * Rejoin the session this conversation had last time, when there is one and the agent still knows
   * it. `session/list` is consulted first because `session/resume` on a forgotten id is an error,
   * and an error is not how a relaunch should report "your old session aged out".
   */
  private async tryResume(
    conversationId: string,
    root: string,
    instance: HarnessInstance,
    mcpServers: readonly McpServer[],
  ): Promise<{ sessionId: string; options: readonly AssistantOption[]; origin: "resumed" } | null> {
    if (!this.options.sessionBook || !instance.connection.canResume) return null;
    let sessionId: string | null = null;
    try {
      sessionId = await this.options.sessionBook.get(conversationId);
    } catch (error) {
      this.options.log.warn("assistant.session_book_failed", errorField(error));
      return null;
    }
    if (sessionId === null) return null;
    try {
      const listed = await instance.connection.agent.listSessions({ cwd: root });
      if (!listed.sessions.some((candidate) => candidate.sessionId === sessionId)) {
        await this.options.sessionBook.forget(conversationId);
        return null;
      }
      const response = await instance.connection.agent.resumeSession({
        sessionId,
        cwd: root,
        mcpServers: [...mcpServers],
      });
      return {
        sessionId,
        options: toAssistantOptions(response.configOptions),
        origin: "resumed",
      };
    } catch (error) {
      // A session the agent refuses to resume is one this conversation must stop pointing at, or
      // every launch retries the same failure before falling back.
      this.options.log.warn("assistant.resume_failed", errorField(error));
      await this.options.sessionBook.forget(conversationId).catch(() => undefined);
      return null;
    }
  }

  /** Send one turn. Resolves when the turn ends, which is when `session/prompt` settles. */
  async prompt(conversationId: string, text: string): Promise<AssistantTurnResult> {
    const state = this.conversations.get(conversationId);
    if (!state) throw new AssistantUnavailable("boot_failed", "That conversation is not open.");
    const instance = this.instances.get(state.workspaceRoot);
    if (!instance || instance.exited) {
      return { stopReason: null, reason: "boot_failed", detail: "The assistant process is gone." };
    }
    // Echoed into the timeline here rather than waiting for `user_message_chunk`, so the message
    // appears the moment it is sent instead of after the agent has committed it.
    this.append(state, {
      kind: "user",
      id: `user-${this.now()}`,
      at: this.now(),
      text,
    });
    state.inFlight = true;
    this.markBusy(instance);
    try {
      const result = await instance.connection.agent.prompt({
        sessionId: state.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      const stopReason = toStopReason(result.stopReason);
      this.append(state, { kind: "turn", id: `turn-${this.now()}`, at: this.now(), stopReason });
      this.lastFailure = null;
      return { stopReason, reason: null, detail: null };
    } catch (error) {
      const failure = classifyTurnFailure(error);
      this.lastFailure = failure;
      this.append(state, {
        kind: "error",
        id: `error-${this.now()}`,
        at: this.now(),
        reason: failure.reason,
        detail: failure.detail,
      });
      this.options.log.warn("assistant.turn_failed", { conversationId, reason: failure.reason });
      return { stopReason: null, reason: failure.reason, detail: failure.detail };
    } finally {
      state.inFlight = false;
      this.markIdleIfQuiet(instance);
    }
  }

  /**
   * Cancel the turn in flight. The in-flight `prompt` then settles with a `cancelled` stop reason,
   * which is why this returns nothing: the answer arrives on the promise the caller already holds.
   */
  cancel(conversationId: string): void {
    const state = this.conversations.get(conversationId);
    if (!state) return;
    const instance = this.instances.get(state.workspaceRoot);
    if (!instance || instance.exited) return;
    // Any permission this turn was blocked on has to be released too, or the agent waits for an
    // answer that will never come and the cancellation never reaches a terminal state.
    for (const [requestId, resolve] of [...this.approvals]) {
      if (requestId.startsWith(`${state.acpSessionId}:`)) {
        this.approvals.delete(requestId);
        resolve(null);
        this.options.emit({ type: "approval_resolved", conversationId, requestId });
      }
    }
    void instance.connection.agent.cancel({ sessionId: state.acpSessionId });
    this.options.log.info("assistant.cancelled", { conversationId });
  }

  /** Answer a pending approval. `null` answers `cancelled`, which ACP treats as a refusal to decide. */
  decide(requestId: string, optionId: string | null): void {
    const resolve = this.approvals.get(requestId);
    if (!resolve) return;
    this.approvals.delete(requestId);
    resolve(optionId);
  }

  /**
   * Change one session configuration option — in practice the model.
   *
   * The response carries the complete option state, not a delta, because changing one option can
   * change what the others admit. A concurrent change applies to the *next* turn: a prompt snapshots
   * its route at admission and pins it for every model step in that turn.
   */
  async setOption(
    conversationId: string,
    configId: string,
    value: string,
  ): Promise<readonly AssistantOption[]> {
    const state = this.conversations.get(conversationId);
    if (!state) throw new AssistantUnavailable("boot_failed", "That conversation is not open.");
    const instance = this.instances.get(state.workspaceRoot);
    if (!instance || instance.exited) {
      throw new AssistantUnavailable("boot_failed", "The assistant process is gone.");
    }
    const response = await instance.connection.agent.setSessionConfigOption({
      sessionId: state.acpSessionId,
      configId,
      value,
    });
    state.options = toAssistantOptions(response.configOptions);
    this.options.emit({ type: "options", conversationId, options: state.options });
    return state.options;
  }

  /** Close a conversation's session. The child stays until it goes idle. */
  async close(conversationId: string): Promise<void> {
    const state = this.conversations.get(conversationId);
    if (!state) return;
    this.conversations.delete(conversationId);
    this.sessionOwners.delete(state.acpSessionId);
    const instance = this.instances.get(state.workspaceRoot);
    instance?.sessionIds.delete(state.acpSessionId);
    if (instance && !instance.exited) {
      try {
        await instance.connection.agent.closeSession({ sessionId: state.acpSessionId });
      } catch (error) {
        // A session that cannot be closed is one the child has already lost; the child's own
        // teardown frees it, so this is worth a line and nothing more.
        this.options.log.warn("assistant.close_failed", { conversationId, ...errorField(error) });
      }
      this.markIdleIfQuiet(instance);
    }
  }

  /**
   * Drop every child, leaving the supervisor usable so the next `open` spawns a fresh one.
   *
   * Adding a model provider key is what this is for. A key reaches a child through its environment at
   * spawn time, so a child started before the key existed can never acquire it — without this, adding a
   * key in Settings → Models appears to do nothing until the app is restarted, and nothing says so. An
   * open conversation survives it: the ACP session id is in the transcript store, so `open` resumes
   * rather than starting over.
   */
  async restart(): Promise<void> {
    const instances = [...this.instances.values()];
    this.instances.clear();
    this.conversations.clear();
    this.sessionOwners.clear();
    // A pending approval belongs to a child that is going away, so it is answered "cancelled" rather
    // than left to hang a turn that can no longer be completed.
    for (const [, resolve] of this.approvals) resolve(null);
    this.approvals.clear();
    await Promise.all(instances.map((instance) => this.stop(instance)));
  }

  /**
   * Shut every child down on quit: end stdin first, because `dsh-acp-app` binds stdin EOF to a
   * bounded shutdown and that is the graceful path, then escalate. Unlike `restart`, this one is final —
   * `disposed` stops anything spawning again.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.restart();
  }

  // ── children ──────────────────────────────────────────────────────────────────────────────────

  private locate(): HarnessLocation | null {
    if (this.options.locate) return this.options.locate();
    return locateHarness({
      candidates: [
        process.env[HARNESS_ROOT_ENV] ?? "",
        // Packaged: beside the staged web server under `Resources`, never inside `app.asar`.
        process.resourcesPath ? join(process.resourcesPath, "harness") : "",
        // From the workspace: what `scripts/vendor-harness.mjs` materialises. One `..` only — this
        // resolves against the bundled `dist/main.js`, not against this source file, so the workspace
        // root is `dist/../build`. `stagedWebRoot()` in `index.ts` walks the same single step.
        join(import.meta.dirname, "..", "build", "harness"),
      ],
      exists: existsSync,
      join,
    });
  }

  private async providerKeys(): Promise<Partial<Record<AssistantProvider, string>>> {
    try {
      return await this.options.keyring.providerKeys();
    } catch (error) {
      // A keychain that cannot be read is not a missing key, but for the user it is the same next
      // step, and guessing "the key is absent" is the safe guess.
      this.options.log.warn("assistant.keyring_failed", errorField(error));
      return {};
    }
  }

  /**
   * The MCP entries a session mounts. The same list goes to `session/new` and `session/resume`,
   * because resume re-mounts MCP configs from scratch rather than restoring the previous ones — a
   * resume built from a stale port would produce a session whose every tool fails.
   */
  private mcpServers(): McpServer[] {
    if (this.options.tools === null) return [];
    try {
      const entry = this.options.tools.mcpServer();
      // Copied into mutable arrays because ACP's own type wants them; the source is readonly so this
      // is where the boundary is crossed, and it is a copy rather than a cast.
      return [
        {
          type: "http",
          name: entry.name,
          url: entry.url,
          headers: entry.headers.map((header) => ({ name: header.name, value: header.value })),
        },
      ];
    } catch (error) {
      // The relay is not running. Worth a line, because "why can it not read my document" needs an
      // answer, and it is not a reason to refuse the whole assistant.
      this.options.log.warn("assistant.mcp_unattached", errorField(error));
      return [];
    }
  }

  /** The child for a workspace root, spawned on first use and shared by every session on it. */
  private async instance(root: string): Promise<HarnessInstance> {
    if (this.disposed) throw new AssistantUnavailable("boot_failed", "The app is shutting down.");
    const live = this.instances.get(root);
    if (live && !live.exited) return live;
    const starting = this.starting.get(root);
    if (starting) return await starting;
    const pending = this.start(root).finally(() => this.starting.delete(root));
    this.starting.set(root, pending);
    return await pending;
  }

  private async start(root: string): Promise<HarnessInstance> {
    const location = this.locate();
    if (location === null) {
      throw new AssistantUnavailable(
        "harness_missing",
        "This build shipped without the assistant runtime.",
      );
    }
    const keys = await this.providerKeys();
    const providers = (["openai", "anthropic"] as const).filter((name) => keys[name] !== undefined);
    if (providers.length === 0) {
      // Not spawned at all, deliberately: a child with no route would boot, advertise nothing, and
      // fail the first turn with a provider error instead of the one thing the user can fix.
      throw new AssistantUnavailable("key_required", null);
    }
    const preference = (await this.options.modelPreference?.()) ?? { provider: null, model: null };
    const paths = await writeHarnessProfile({
      userData: this.options.userData,
      providers,
      defaultProvider: preference.provider,
      defaultModel: preference.model,
    });

    const env: Record<string, string> = {
      // A curated environment, not `process.env`: the child gets a shell and the agent can read its
      // own environment, so anything inherited here is something the agent can see.
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      // Electron's binary runs as plain Node with this set, so no second runtime is shipped. Every
      // native addon in the harness tree is Node-API, which is ABI-stable across the two.
      ELECTRON_RUN_AS_NODE: "1",
      DSH_HOME: paths.home,
      SYMPLIST_DSH_PROFILE: paths.dir,
      DSH_PERMISSION_MODE: "workspace-write",
      // Belt to the generated patch's `disabled: true`. Any non-empty value disables.
      DSH_TELEMETRY_DISABLED: "1",
    };
    for (const provider of providers) {
      const value = keys[provider];
      if (value !== undefined) env[providerKeyEnv[provider]] = value;
    }

    const spawnChild = this.options.spawn ?? defaultSpawn;
    const child = spawnChild({ launcher: location.launcher, cwd: root, env });
    const stderr = this.captureStderr(child);

    // The exit listener is attached before the connection is negotiated, because a child that dies
    // during `initialize` is the most likely way this fails and its exit must still be observed.
    let instance: HarnessInstance | null = null;
    child.once("exit", (code, signal) => {
      if (instance !== null) {
        instance.exited = true;
        if (this.instances.get(root) === instance) this.instances.delete(root);
        this.forgetSessionsOf(instance);
      }
      this.options.log.info("assistant.child_exited", {
        code: code ?? -1,
        signal: signal ?? "none",
      });
    });

    const connect = this.options.connect ?? connectAcp;
    let connection: AcpConnection;
    try {
      connection = await connect(child, {
        onUpdate: (notification) => this.onUpdate(notification),
        onPermission: (request) => this.onPermission(request),
      });
    } catch (error) {
      // dsh fails loud with one labelled line naming the plugin that refused, and that line is the
      // only useful thing to show a user whose app will not start its assistant.
      const detail = stderr.tail() || errorMessage(error);
      const failure = {
        reason: "boot_failed" as const,
        detail: redactSecrets(detail).slice(-1_000),
      };
      this.lastFailure = failure;
      this.options.log.error("assistant.boot_failed", errorField(error));
      try {
        child.stdin.end();
      } catch {
        // Already closed, which is the state this was reaching for.
      }
      child.kill("SIGTERM");
      throw new AssistantUnavailable("boot_failed", failure.detail);
    }

    instance = {
      root,
      child,
      connection,
      sessionIds: new Set(),
      idleSince: null,
      idleTimer: null,
      exited: false,
    };
    this.instances.set(root, instance);
    this.lastFailure = null;
    this.options.log.info("assistant.child_started", {
      pid: child.pid ?? -1,
      resume: connection.canResume,
      httpMcp: connection.canAttachHttpMcp,
    });
    return instance;
  }

  /** Keep the last of a child's stderr, redacted, for a boot failure to quote. */
  private captureStderr(child: HarnessChild): { tail: () => string } {
    let buffer = "";
    const stderr = child.stderr;
    if (stderr) {
      stderr.setEncoding?.("utf8");
      stderr.on("data", (chunk: string | Buffer) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        buffer = (buffer + text).slice(-STDERR_KEEP_BYTES);
        for (const line of text.split("\n")) this.options.log.child("dsh", line);
      });
    }
    return { tail: () => redactSecrets(buffer.trimEnd()) };
  }

  private async stop(instance: HarnessInstance): Promise<void> {
    if (instance.idleTimer) clearTimeout(instance.idleTimer);
    if (instance.exited) return;
    const exited = new Promise<void>((resolve) => {
      instance.child.once("exit", () => resolve());
      // The timer is the escalation, not the answer: a wedged plugin must not hold quit open.
      setTimeout(() => {
        instance.child.kill("SIGKILL");
        resolve();
      }, 3_000).unref?.();
    });
    try {
      // The graceful path: `dsh-acp-app` binds stdin EOF to a bounded shutdown.
      instance.child.stdin.end();
    } catch {
      // A stdin that is already closed is the state this was trying to reach.
    }
    instance.child.kill("SIGTERM");
    await exited;
  }

  private markBusy(instance: HarnessInstance): void {
    instance.idleSince = null;
    if (instance.idleTimer) {
      clearTimeout(instance.idleTimer);
      instance.idleTimer = null;
    }
  }

  /** Arm the reaper once a child holds no session and no turn is running. */
  private markIdleIfQuiet(instance: HarnessInstance): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.workspaceRoot === instance.root && conversation.inFlight) return;
    }
    if (instance.sessionIds.size > 0) return;
    if (instance.idleTimer) return;
    instance.idleSince = this.now();
    instance.idleTimer = setTimeout(() => {
      instance.idleTimer = null;
      if (instance.sessionIds.size > 0) return;
      this.instances.delete(instance.root);
      void this.stop(instance);
      this.options.log.info("assistant.child_reaped", { pid: instance.child.pid ?? -1 });
    }, this.idleTimeoutMs);
    instance.idleTimer.unref?.();
  }

  private forgetSessionsOf(instance: HarnessInstance): void {
    for (const sessionId of instance.sessionIds) {
      const conversationId = this.sessionOwners.get(sessionId);
      this.sessionOwners.delete(sessionId);
      if (conversationId) this.conversations.delete(conversationId);
    }
    instance.sessionIds.clear();
  }

  // ── the client side of the connection ─────────────────────────────────────────────────────────

  private onUpdate(notification: SessionNotification): void {
    const conversationId = this.sessionOwners.get(notification.sessionId);
    if (conversationId === undefined) return;
    const state = this.conversations.get(conversationId);
    if (!state) return;
    const effect = projectUpdate(notification.update, { tools: state.tools, now: this.now });
    if (effect.kind === "entry") this.append(state, effect.entry);
    else if (effect.kind === "options") {
      state.options = effect.options;
      this.options.emit({ type: "options", conversationId, options: state.options });
    }
  }

  private async onPermission(request: RequestPermissionRequest): Promise<string | null> {
    const conversationId = this.sessionOwners.get(request.sessionId);
    if (conversationId === undefined) return null;
    // Prefixed with the session id so a cancellation can release every approval that turn is
    // blocked on without tracking them a second time.
    const requestId = `${request.sessionId}:${request.toolCall.toolCallId}:${this.now()}`;
    const approval: AssistantApproval = {
      requestId,
      conversationId,
      toolCallId: request.toolCall.toolCallId,
      title: request.toolCall.title ?? request.toolCall.toolCallId,
      name: request.toolCall.name ?? null,
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    };
    return await new Promise<string | null>((resolve) => {
      this.approvals.set(requestId, resolve);
      this.options.emit({ type: "approval", approval });
    });
  }

  private append(state: ConversationState, entry: AssistantTimelineEntry): void {
    // A tool call is one entry that changes, not a new entry per update, so its updates replace.
    const index =
      entry.kind === "tool"
        ? state.timeline.findIndex(
            (candidate) => candidate.kind === "tool" && candidate.id === entry.id,
          )
        : -1;
    if (index >= 0) state.timeline[index] = entry;
    else {
      state.timeline.push(entry);
      if (state.timeline.length > TIMELINE_LIMIT) state.timeline.shift();
    }
    this.options.emit({ type: "timeline", conversationId: state.conversationId, entry });
  }
}

/**
 * Spawn the launcher under Electron's own Node.
 *
 * `child_process.spawn(process.execPath, …)` with `ELECTRON_RUN_AS_NODE` rather than
 * `utilityProcess.fork`, for one concrete reason: ACP is a stdin/stdout protocol and the client has
 * to write to the child's stdin. `utilityProcess` exposes `stdout` and `stderr` and no writable
 * stdin, so it cannot carry this conversation at all.
 */
function defaultSpawn(spec: HarnessSpawnSpec): HarnessChild {
  return spawnProcess(nodeRunnerPath(), [spec.launcher], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    // Detached would survive the app; the assistant's lifetime is the app's.
    detached: false,
  }) as unknown as HarnessChild;
}

/** A model call that failed for want of a key is a different answer from one that simply failed. */
function classifyTurnFailure(error: unknown): {
  readonly reason: AssistantUnavailableReason;
  readonly detail: string | null;
} {
  const message = errorMessage(error);
  // `dsh-llm-pi-ai` fails an `apiKeyEnv` reference that resolves to nothing with `MISSING_CREDENTIAL`
  // and a key the provider rejects with `INVALID_CREDENTIAL`. Both mean "fix the key", and the
  // desktop heir of the cloud's `ai.key_required` is exactly that answer rather than a Retry that
  // can only fail again.
  if (/MISSING_CREDENTIAL|INVALID_CREDENTIAL|invalid_api_key|\b401\b/i.test(message)) {
    return { reason: "key_required", detail: redactSecrets(message).slice(0, 500) };
  }
  return { reason: "provider_failed", detail: redactSecrets(message).slice(0, 500) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

/** Log fields for an error: a stable name and nothing free-text. */
function errorField(error: unknown): { readonly error: string } {
  return { error: error instanceof Error ? error.name : "unknown" };
}
