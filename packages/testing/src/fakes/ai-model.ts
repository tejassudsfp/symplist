import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * A scripted language model for tests (§8.6, §17), built on the AI SDK 7 `MockLanguageModelV4` and
 * `simulateReadableStream`. Each model call (`doStream` or `doGenerate`) consumes the next scripted
 * turn: text, reasoning, tool calls, in-stream errors, or a rejected call. A multi-step agent loop is
 * a script with one turn per step. Calling past the end of the script fails loudly.
 */

export type ScriptedPart =
  | { readonly type: "text"; readonly text: string; readonly chunkSize?: number }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly toolName: string;
      readonly input: unknown;
      readonly toolCallId?: string;
    }
  /** An `error` stream part; `doGenerate` throws it instead. */
  | { readonly type: "error"; readonly error: unknown };

export interface ScriptedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
}

export interface ScriptedResponse {
  readonly kind?: "response";
  readonly parts: readonly ScriptedPart[];
  /** Defaults to `tool-calls` when the turn has a tool call, `error` after an error part, else `stop`. */
  readonly finishReason?: LanguageModelV4FinishReason["unified"];
  readonly usage?: ScriptedUsage;
}

/** A call the provider rejects outright, for example an HTTP 429 or a network failure. */
export interface ScriptedRejection {
  readonly kind: "reject";
  readonly error: unknown;
}

export type ScriptedTurn = ScriptedResponse | ScriptedRejection;

export interface ScriptedModelOptions {
  readonly provider?: string;
  readonly modelId?: string;
  /** Delay between stream chunks; defaults to none. */
  readonly chunkDelayInMs?: number | null;
}

export interface ScriptedModel {
  readonly model: MockLanguageModelV4;
  /** Call options of every `doStream` and `doGenerate` call, in call order. */
  readonly calls: readonly LanguageModelV4CallOptions[];
  /** Turns not yet consumed. */
  remaining(): number;
}

export class ScriptExhaustedError extends Error {
  override readonly name = "ScriptExhaustedError";
}

export function scriptedText(
  text: string,
  options: Omit<ScriptedResponse, "parts"> = {},
): ScriptedResponse {
  return { ...options, parts: [{ type: "text", text }] };
}

export function scriptedToolCall(
  toolName: string,
  input: unknown,
  options: Omit<ScriptedResponse, "parts"> & {
    readonly toolCallId?: string;
    readonly text?: string;
  } = {},
): ScriptedResponse {
  const { toolCallId, text, ...rest } = options;
  return {
    ...rest,
    parts: [
      ...(text === undefined ? [] : [{ type: "text", text } as const]),
      { type: "tool-call", toolName, input, ...(toolCallId === undefined ? {} : { toolCallId }) },
    ],
  };
}

export function scriptedStreamError(error: unknown, textBefore?: string): ScriptedResponse {
  return {
    parts: [
      ...(textBefore === undefined ? [] : [{ type: "text", text: textBefore } as const]),
      { type: "error", error },
    ],
  };
}

export function scriptedRejection(error: unknown): ScriptedRejection {
  return { kind: "reject", error };
}

function usageFor(response: ScriptedResponse): LanguageModelV4Usage {
  const textLength = response.parts.reduce(
    (total, part) =>
      total + (part.type === "text" || part.type === "reasoning" ? part.text.length : 0),
    0,
  );
  const reasoning = response.usage?.reasoningTokens ?? 0;
  const output = response.usage?.outputTokens ?? Math.max(1, Math.ceil(textLength / 4)) + reasoning;
  const input = response.usage?.inputTokens ?? 12;
  const cached = response.usage?.cachedInputTokens ?? 0;
  return {
    inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 },
    outputTokens: { total: output, text: output - reasoning, reasoning },
  };
}

function finishReasonFor(response: ScriptedResponse): LanguageModelV4FinishReason {
  if (response.finishReason !== undefined)
    return { unified: response.finishReason, raw: response.finishReason };
  const types = response.parts.map((part) => part.type);
  const unified = types.includes("error")
    ? "error"
    : types.includes("tool-call")
      ? "tool-calls"
      : "stop";
  return { unified, raw: unified };
}

function chunkText(text: string, size: number): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(""));
  }
  return chunks.length === 0 ? [""] : chunks;
}

export function createScriptedModel(
  script: readonly ScriptedTurn[],
  options: ScriptedModelOptions = {},
): ScriptedModel {
  const turns = [...script];
  const calls: LanguageModelV4CallOptions[] = [];
  const provider = options.provider ?? "scripted";
  const modelId = options.modelId ?? "scripted-model";
  let callIndex = 0;

  const next = (
    callOptions: LanguageModelV4CallOptions,
  ): { response: ScriptedResponse; call: number } => {
    calls.push(callOptions);
    callIndex += 1;
    const turn = turns.shift();
    if (turn === undefined) {
      throw new ScriptExhaustedError(`The scripted model has no turn left for call ${callIndex}`);
    }
    if (turn.kind === "reject") throw turn.error;
    return { response: turn, call: callIndex };
  };

  const toolCallIdFor = (
    call: number,
    index: number,
    part: Extract<ScriptedPart, { type: "tool-call" }>,
  ) => part.toolCallId ?? `call_${call}_${index}`;

  const doStream = async (
    callOptions: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> => {
    const { response, call } = next(callOptions);
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: `response_${call}`, modelId, timestamp: new Date(0) },
    ];
    let stoppedByError = false;
    response.parts.forEach((part, index) => {
      if (stoppedByError) return;
      switch (part.type) {
        case "text": {
          const id = `text_${call}_${index}`;
          chunks.push({ type: "text-start", id });
          for (const delta of chunkText(part.text, part.chunkSize ?? 8)) {
            chunks.push({ type: "text-delta", id, delta });
          }
          chunks.push({ type: "text-end", id });
          break;
        }
        case "reasoning": {
          const id = `reasoning_${call}_${index}`;
          chunks.push({ type: "reasoning-start", id });
          chunks.push({ type: "reasoning-delta", id, delta: part.text });
          chunks.push({ type: "reasoning-end", id });
          break;
        }
        case "tool-call": {
          const toolCallId = toolCallIdFor(call, index, part);
          const input = JSON.stringify(part.input);
          chunks.push({ type: "tool-input-start", id: toolCallId, toolName: part.toolName });
          chunks.push({ type: "tool-input-delta", id: toolCallId, delta: input });
          chunks.push({ type: "tool-input-end", id: toolCallId });
          chunks.push({ type: "tool-call", toolCallId, toolName: part.toolName, input });
          break;
        }
        case "error":
          chunks.push({ type: "error", error: part.error });
          stoppedByError = true;
          break;
      }
    });
    chunks.push({
      type: "finish",
      finishReason: finishReasonFor(response),
      usage: usageFor(response),
    });
    return {
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: options.chunkDelayInMs ?? null,
      }),
    };
  };

  const doGenerate = async (
    callOptions: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> => {
    const { response, call } = next(callOptions);
    const content: LanguageModelV4Content[] = [];
    response.parts.forEach((part, index) => {
      switch (part.type) {
        case "text":
          content.push({ type: "text", text: part.text });
          break;
        case "reasoning":
          content.push({ type: "reasoning", text: part.text });
          break;
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: toolCallIdFor(call, index, part),
            toolName: part.toolName,
            input: JSON.stringify(part.input),
          });
          break;
        case "error":
          throw part.error;
      }
    });
    return {
      content,
      finishReason: finishReasonFor(response),
      usage: usageFor(response),
      warnings: [],
      response: { id: `response_${call}`, modelId, timestamp: new Date(0) },
    };
  };

  const model = new MockLanguageModelV4({ provider, modelId, doStream, doGenerate });
  return { model, calls, remaining: () => turns.length };
}
