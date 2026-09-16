import {
  convertToModelMessages,
  isStepCount,
  type StepResult,
  streamText,
  type ToolSet,
  toUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  validateUIMessages,
} from "ai";
import {
  assertNoProviderExecutedTools,
  type SelectedSimonModel,
  SimonModelError,
} from "./providers.ts";
import { simonInstructions } from "./rules.ts";

export type SimonLoopStatus =
  | "running"
  | "completed"
  | "stopped"
  | "failed"
  | "awaiting_approval"
  | "awaiting_user";
export interface SimonLoopCheckpoint {
  readonly message: UIMessage;
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly status: SimonLoopStatus;
}
export interface SimonLoopDependencies {
  readonly runId: string;
  readonly kind: "task" | "quick";
  readonly selectedModel: SelectedSimonModel;
  /** Loaded from owner-bound encrypted storage, never supplied by the browser. */
  readonly history: readonly UIMessage[];
  /** Only task identity/title/revision/read positions; never the document body. */
  readonly initialContext?: string;
  readonly tools: ToolSet;
  readonly signal: AbortSignal;
  /** Fresh generation, cancellation, task and access check before every step and tool. */
  readonly mayExecute: () => Promise<boolean>;
  /** A pending native pause is committed together with its complete step snapshot. */
  readonly pauseStatus: () => "awaiting_approval" | "awaiting_user" | null;
  readonly checkpoint: (snapshot: SimonLoopCheckpoint) => Promise<void>;
  readonly sink: { write(chunk: UIMessageChunk): Promise<void> };
  readonly log: (event: {
    code: "ai.provider_failed" | "ai.checkpoint_failed" | "ai.relay_failed";
  }) => void;
}

/** The only model loop, shared unchanged by local and durable execution (§8.1). */
export async function runSimonModelLoop(
  deps: SimonLoopDependencies,
): Promise<{ status: SimonLoopStatus; steps: number }> {
  assertNoProviderExecutedTools(deps.tools);
  if (typeof deps.selectedModel.model !== "object") throw new SimonModelError("ai.unavailable");
  globalThis.AI_SDK_LOG_WARNINGS = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([deps.signal, controller.signal]);
  let failure = false;
  let fenced = false;
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let callsInStep = 0;
  let partialText = "";
  const pendingRelay: UIMessageChunk[] = [];
  let bufferingPause = false;
  let message: UIMessage = { id: deps.runId, role: "assistant", parts: [] };
  const fail = (code: "ai.provider_failed" | "ai.checkpoint_failed") => {
    failure = true;
    deps.log({ code });
    controller.abort();
  };
  const assertActive = async () => {
    if (signal.aborted) throw new SimonModelError("ai.provider_failed");
    if (!(await deps.mayExecute())) {
      fenced = true;
      controller.abort();
      throw new SimonModelError("ai.provider_failed");
    }
  };
  const tools: ToolSet = Object.fromEntries(
    Object.entries(deps.tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (!execute || definition.needsApproval) throw new SimonModelError("ai.tool_forbidden");
      return [
        name,
        {
          ...definition,
          execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
            // Reserve synchronously before awaits: even a noncompliant provider cannot run two actions.
            callsInStep += 1;
            if (callsInStep > 1 || deps.pauseStatus() !== null)
              return { status: "failed", code: "tool.split_call" };
            await assertActive();
            try {
              return await execute(input, options);
            } catch {
              // Do not feed provider exception text into model history, streamed UI errors or telemetry.
              return { status: "failed", code: "tool.failed" };
            }
          },
        },
      ];
    }),
  );
  let history: UIMessage[];
  try {
    if (deps.history.some((item) => item.role === "system"))
      throw new SimonModelError("ai.invalid_history");
    history = await validateUIMessages({ messages: [...deps.history], tools });
  } catch {
    throw new SimonModelError("ai.invalid_history");
  }
  const modelMessages = await convertToModelMessages(history, { tools });
  const save = async (status: SimonLoopStatus) => {
    try {
      await deps.checkpoint({
        message: structuredClone(message),
        steps,
        inputTokens,
        outputTokens,
        status,
      });
    } catch {
      // SDK lifecycle callbacks swallow exceptions. Explicitly abort so a failed checkpoint cannot
      // advance the model to another step or authorize another action.
      fail("ai.checkpoint_failed");
    }
  };
  const result = streamText({
    model: deps.selectedModel.model,
    instructions: [simonInstructions(deps.kind), deps.initialContext].filter(Boolean).join("\n\n"),
    messages: modelMessages,
    tools,
    stopWhen: [isStepCount(10), () => deps.pauseStatus() !== null || failure || fenced],
    abortSignal: signal,
    maxRetries: 0,
    streamRetries: 0,
    telemetry: { isEnabled: false },
    providerOptions: { openai: { parallelToolCalls: false, store: false, reasoningSummary: null } },
    prepareStep: async () => {
      await assertActive();
      assertNoProviderExecutedTools(tools);
      callsInStep = 0;
      partialText = "";
      return {};
    },
    onChunk: ({ chunk }) => {
      if (chunk.type === "text-delta") partialText += chunk.text;
    },
    onError: () => {
      if (!fenced && !deps.signal.aborted) fail("ai.provider_failed");
    },
    onStepEnd: async (step) => {
      steps += 1;
      inputTokens += boundedCount(step.usage.inputTokens);
      outputTokens += boundedCount(step.usage.outputTokens);
      message = { ...message, parts: [...message.parts, ...stepParts(step)] };
      partialText = "";
      await save(deps.pauseStatus() ?? "running");
    },
  });
  try {
    const stream = toUIMessageStream({
      stream: result.stream,
      tools,
      generateMessageId: () => deps.runId,
      sendReasoning: false,
      onError: () => "ai.provider_failed",
    });
    const reader = stream.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (!signal.aborted) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        try {
          const output = chunk.type === "tool-output-available" ? chunk.output : null;
          if (
            output &&
            typeof output === "object" &&
            "status" in output &&
            (output.status === "awaiting_approval" || output.status === "awaiting_user")
          )
            bufferingPause = true;
          if (bufferingPause) pendingRelay.push(safeChunk(chunk));
          else await deps.sink.write(safeChunk(chunk));
        } catch {
          // Viewers are optional. A disconnected output relay must not stop durable checkpoints.
          deps.log({ code: "ai.relay_failed" });
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
      reader.releaseLock();
    }
  } catch {
    if (!fenced && !deps.signal.aborted) fail("ai.provider_failed");
  }
  if (partialText) message.parts.push({ type: "text", text: partialText, state: "done" });
  const status = failure
    ? "failed"
    : deps.signal.aborted
      ? "stopped"
      : fenced
        ? "stopped"
        : (deps.pauseStatus() ?? "completed");
  if (!fenced && !deps.pauseStatus()) await save(status);
  if (!failure && !fenced) {
    for (const chunk of pendingRelay) {
      try {
        await deps.sink.write(chunk);
      } catch {
        deps.log({ code: "ai.relay_failed" });
      }
    }
  }
  return { status: failure ? "failed" : status, steps };
}

function boundedCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value ?? 0) : 0;
}

/** Persist provider reasoning metadata encrypted for stateless continuation, never render it. */
function stepParts(step: StepResult<ToolSet>): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [{ type: "step-start" }];
  for (const content of step.content) {
    if (content.type === "text" || content.type === "reasoning") {
      parts.push({
        type: content.type,
        text: content.text,
        state: "done",
        ...(content.providerMetadata ? { providerMetadata: content.providerMetadata } : {}),
      });
    } else if (content.type === "tool-call") {
      const result = step.content.find(
        (item) =>
          (item.type === "tool-result" || item.type === "tool-error") &&
          item.toolCallId === content.toolCallId,
      );
      parts.push(
        result?.type === "tool-result"
          ? {
              type: "dynamic-tool",
              toolName: content.toolName,
              toolCallId: content.toolCallId,
              state: "output-available",
              input: content.input,
              output: result.output,
              ...(content.providerMetadata
                ? { callProviderMetadata: content.providerMetadata }
                : {}),
            }
          : {
              type: "dynamic-tool",
              toolName: content.toolName,
              toolCallId: content.toolCallId,
              state: "output-error",
              input: content.input,
              errorText: "tool.failed",
            },
      );
    }
  }
  return parts;
}

function safeChunk(chunk: UIMessageChunk): UIMessageChunk {
  if (chunk.type === "error") return { ...chunk, errorText: "ai.provider_failed" };
  if (chunk.type === "tool-output-error" || chunk.type === "tool-input-error")
    return { ...chunk, errorText: "tool.failed" };
  if (chunk.type === "abort") return { type: "abort" };
  return chunk;
}
