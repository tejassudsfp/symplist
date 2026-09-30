/**
 * The assistant's IPC group: the only way the renderer reaches the harness.
 *
 * It registers through the guarded `handle` the registry hands it, so every call inherits the sender
 * check — top frame, renderer origin — for free. Nothing here exposes a raw `spawn`, and no channel
 * ever returns a key: `status` reports *which* provider keys exist as two booleans, and that is the
 * whole of what the renderer learns about them.
 *
 * Every argument arrives from page script, so every argument is validated here rather than trusted
 * into the supervisor. A refused call answers with a typed failure the UI can render, never a thrown
 * string, because "the renderer asks for an effect" cuts both ways: it should get an answer.
 */
import type {
  AssistantOption,
  AssistantSession,
  AssistantStatus,
  AssistantTimelineEntry,
  AssistantTurnResult,
} from "../shared/assistant.ts";
import { assistantChannels } from "../shared/assistant.ts";
import { AssistantUnavailable } from "./harness/supervisor.ts";
import type { MainLog } from "./log.ts";

/** The slice of `HarnessSupervisor` this group drives, so a test needs no child process. */
export interface AssistantService {
  status(): Promise<AssistantStatus>;
  timeline(conversationId: string): readonly AssistantTimelineEntry[];
  open(conversationId: string, workspaceRoot?: string): Promise<AssistantSession>;
  prompt(conversationId: string, text: string): Promise<AssistantTurnResult>;
  cancel(conversationId: string): void;
  close(conversationId: string): Promise<void>;
  setOption(
    conversationId: string,
    configId: string,
    value: string,
  ): Promise<readonly AssistantOption[]>;
  decide(requestId: string, optionId: string | null): void;
}

/** The registrar `registerIpcHandlers` hands out; identical to its own local `handle`. */
export type GuardedHandle = <Args extends readonly unknown[], Result>(
  channel: string,
  handler: (...args: Args) => Result | Promise<Result>,
) => void;

/** The longest prompt the renderer may submit. A guard against an accident, not against a user. */
const MAX_PROMPT_BYTES = 200_000;

export function registerAssistantHandlers(
  handle: GuardedHandle,
  assistant: AssistantService,
  log: MainLog,
): void {
  handle(assistantChannels.assistantStatus, async (): Promise<AssistantStatus> => {
    return await assistant.status();
  });

  handle(
    assistantChannels.assistantTimeline,
    (conversationId: unknown): readonly AssistantTimelineEntry[] => {
      const id = requireId(conversationId);
      return id === null ? [] : assistant.timeline(id);
    },
  );

  handle(
    assistantChannels.assistantOpen,
    async (conversationId: unknown, workspaceRoot: unknown): Promise<AssistantSession | null> => {
      const id = requireId(conversationId);
      if (id === null) {
        log.warn("assistant.ipc_rejected", { channel: "open" });
        return null;
      }
      // A workspace root from the renderer would let page script point the agent's shell anywhere
      // on the disk, so it is only accepted as an absolute path and, for now, only the configured
      // one is ever passed — see the note in `remaining`.
      const root =
        typeof workspaceRoot === "string" && workspaceRoot.startsWith("/")
          ? workspaceRoot
          : undefined;
      return await assistant.open(id, root);
    },
  );

  handle(
    assistantChannels.assistantPrompt,
    async (conversationId: unknown, text: unknown): Promise<AssistantTurnResult> => {
      const id = requireId(conversationId);
      if (id === null || typeof text !== "string" || text.trim().length === 0) {
        return { stopReason: null, reason: "provider_failed", detail: "Nothing to send." };
      }
      if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
        return { stopReason: null, reason: "provider_failed", detail: "That message is too long." };
      }
      try {
        return await assistant.prompt(id, text);
      } catch (error) {
        return failureOf(error);
      }
    },
  );

  handle(assistantChannels.assistantCancel, (conversationId: unknown): boolean => {
    const id = requireId(conversationId);
    if (id === null) return false;
    assistant.cancel(id);
    return true;
  });

  handle(assistantChannels.assistantClose, async (conversationId: unknown): Promise<boolean> => {
    const id = requireId(conversationId);
    if (id === null) return false;
    await assistant.close(id);
    return true;
  });

  handle(
    assistantChannels.assistantSetOption,
    async (
      conversationId: unknown,
      configId: unknown,
      value: unknown,
    ): Promise<readonly AssistantOption[]> => {
      const id = requireId(conversationId);
      if (id === null || typeof configId !== "string" || typeof value !== "string") return [];
      try {
        return await assistant.setOption(id, configId, value);
      } catch (error) {
        log.warn("assistant.set_option_failed", {
          reason: error instanceof AssistantUnavailable ? error.reason : "unknown",
        });
        return [];
      }
    },
  );

  handle(assistantChannels.assistantDecide, (requestId: unknown, optionId: unknown): boolean => {
    if (typeof requestId !== "string" || requestId.length === 0) return false;
    // `null` is a real answer here — it is how the renderer says "cancelled" — so it is accepted
    // and anything that is neither a string nor null is refused.
    if (optionId !== null && typeof optionId !== "string") return false;
    assistant.decide(requestId, optionId);
    return true;
  });
}

/** A conversation id the renderer may use: non-empty, short, and free of path or control bytes. */
function requireId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 128) return null;
  if (!/^[\w-]+$/.test(value)) return null;
  return value;
}

/** Turn a supervisor failure into the answer the renderer renders. */
function failureOf(error: unknown): AssistantTurnResult {
  if (error instanceof AssistantUnavailable) {
    return { stopReason: null, reason: error.reason, detail: error.detail };
  }
  return { stopReason: null, reason: "provider_failed", detail: null };
}
