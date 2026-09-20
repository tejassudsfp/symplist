# AI SDK research (verified 2026-09-15)

Scope: Vercel AI SDK latest stable major (AI SDK 7) for Simon's agent loop (Trigger.dev worker), the chat UI (Next.js `useChat`) fed over a NestJS WebSocket, the provider registry (OpenAI default; Amazon Bedrock Anthropic, Google Vertex Anthropic, Together AI optional), approvals, telemetry, and tests.

Method: versions from `npm view` (dist-tags checked, only `latest` used). API facts from ai-sdk.dev and provider docs (the same MDX files ship inside each package's `docs/` folder and were cross-checked against the installed source and `.d.ts`). Every snippet in "Verified APIs" was typechecked with `tsc` 7.0.2 (strict, `skipLibCheck: false`, both `module: nodenext` and `moduleResolution: bundler`), and the flows were run on Node 24.15.0 against the real packages using `MockLanguageModelV4` and a stubbed `fetch`. The experiments lived in a throwaway scratch directory and are not part of the repo.

## Versions

AI SDK 7.0.0 shipped 2026-06-25. Older lines are still maintained under the `ai-v5` and `ai-v6` dist-tags. Do not use the `beta`, `canary`, `alpha` or `snapshot` tags.

| package | version | peer/engine notes |
| --- | --- | --- |
| `ai` | 7.0.101 | peer `zod ^3.25.76 \|\| ^4.1.8`; engines `node >=22`; ESM only; deps pinned exactly: `@ai-sdk/gateway` 4.0.81, `@ai-sdk/provider` 4.0.14, `@ai-sdk/provider-utils` 5.0.40. Published 2026-09-15T04:23Z |
| `@ai-sdk/openai` | 4.0.66 | peer zod as above; node >=22 |
| `@ai-sdk/amazon-bedrock` | 5.0.82 | peer zod; node >=22; subpath `@ai-sdk/amazon-bedrock/anthropic`; depends on `@ai-sdk/anthropic` 4.0.53, `@ai-sdk/openai` 4.0.66, `aws4fetch` |
| `@ai-sdk/google-vertex` | 5.0.82 | peer zod; node >=22; subpaths `./anthropic`, `./anthropic/edge`, `./edge`, `./maas`, `./xai`; depends on `google-auth-library ^10.6.2`, `@ai-sdk/google` 4.0.70, `@ai-sdk/anthropic` 4.0.53. Published 2026-09-15T04:19Z |
| `@ai-sdk/togetherai` | 3.0.49 | peer zod; node >=22; built on `@ai-sdk/openai-compatible` 3.0.48 |
| `@ai-sdk/anthropic` | 4.0.53 | peer zod; node >=22 (only needed directly for types or a direct Anthropic API provider) |
| `@ai-sdk/react` | 4.0.104 | peer `react ^18 \|\| ~19.0.1 \|\| ~19.1.2 \|\| ^19.2.1` (react latest 19.3.0 is in range); node >=22; **depends on `ai` 7.0.101 and `@ai-sdk/mcp` 2.0.49 exactly**. Published 2026-09-15T04:19Z |
| `@ai-sdk/mcp` | 2.0.49 | peer zod; node >=22; MCP **client** (`createMCPClient`), subpath `./mcp-stdio` |
| `ai/test` (subpath of `ai`) | 7.0.101 | `MockLanguageModelV4`, `MockEmbeddingModelV4`, `mockId`, `mockValues` (plus V2/V3 mocks and others in source) |
| `@ai-sdk/provider` | 4.0.14 | only needed directly to type mock usage objects (`LanguageModelV4Usage`); its `.d.ts` imports `json-schema` types |
| `@ai-sdk/otel` | 1.0.101 | optional; OpenTelemetry integration moved here in v7 (not recommended for Symplist, see decisions) |
| `zod` | 4.6.5 | satisfies the `^4.1.8` peer; SDK uses `zod/v4`, `zod/v4/core` and `zod/v3` subpaths, all exported by 4.6.5 |
| `@types/json-schema` | 7.0.15 | devDependency needed when `skipLibCheck` is false under pnpm's strict layout (otherwise TS7016 from `@ai-sdk/provider`'s `.d.ts`) |
| `typescript` | 7.0.2 | works for consuming the AI SDK (evidence below); 6.0.3 produced identical results |

Release-age policy: pnpm 11+ defaults `minimumReleaseAge` to 1440 minutes and applies it to transitive dependencies (https://pnpm.io/settings/dependency-resolution). On 2026-09-15, `ai@7.0.101`, `@ai-sdk/react@4.0.104`, `@ai-sdk/google-vertex@5.0.82`, `@ai-sdk/google@4.0.70`, `@ai-sdk/otel@1.0.101` and `@ai-sdk/gateway@4.0.81` (2026-09-14T19:52Z) are under 24 hours old. They need `minimumReleaseAgeExclude` entries, or the install has to wait a day.

### TypeScript 7 verdict (evidence)

- The AI SDK packages ship plain `.d.ts` files. The SDK is built with TypeScript 5.8.3 (the `ai` devDependency), which does not affect consumers.
- `tsc` 7.0.2 typechecked all of these with 0 errors: tools with zod 4 and `zod/mini`, `streamText` with `toolApproval`, `toUIMessageStream`, a custom `ChatTransport`, a React `useChat` component (TSX), `createProviderRegistry` with the OpenAI, Bedrock Anthropic, Vertex Anthropic and Together providers, and `satisfies OpenAILanguageModelResponsesOptions`. The settings were `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `skipLibCheck: false`, run under both `nodenext` and `bundler`.
- Negative checks proved that types are enforced. `@ts-expect-error` held for a wrong zod-inferred input type, an unknown approval status, an approval key that is not a tool name, an unregistered registry prefix, and a transport missing `reconnectToStream`. Running `tsc` 6.0.3 on the same files gave identical diagnostics.
- The only extra requirement is `@types/json-schema` when `skipLibCheck` is false, and it applies equally to TS 6.
- TypeScript 7.0 has no stable programmatic API. Tools that embed the compiler must stay on 6.x, for example through the `@typescript/typescript6` side-by-side package (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). This does not affect AI SDK usage.

## Verified APIs

### v7 renames that matter here

Source: https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0

- `system` becomes `instructions`. System messages inside `messages` are rejected unless `allowSystemInMessages: true` is set.
- `stepCountIs` becomes `isStepCount`, and `onFinish`/`onStepFinish` become `onEnd`/`onStepEnd`. The old names still exist as deprecated aliases.
- `result.fullStream` becomes `result.stream`. The result methods `toUIMessageStream()`, `toUIMessageStreamResponse()` and `pipeUIMessageStreamToResponse()` are deprecated in favour of the standalone `toUIMessageStream({ stream })`.
- `usage.cachedInputTokens` becomes `usage.inputTokenDetails.cacheReadTokens`, and `usage.reasoningTokens` becomes `usage.outputTokenDetails.reasoningTokens`. `result.usage` now aggregates all steps (`totalUsage` is deprecated). Use `result.finalStep.usage` for the last step only.
- `experimental_context` becomes a per-tool `context`, declared by `contextSchema` and supplied through `toolsContext` keyed by tool name. Shared data goes in `runtimeContext`.
- `needsApproval` on `tool()` is deprecated for `generateText`/`streamText`/`ToolLoopAgent`. Use `toolApproval` on the call instead.
- OpenAI Responses: setting `reasoning` or `reasoningEffort` (other than `'none'`) now defaults `reasoningSummary` to `'detailed'`. Set `reasoningSummary: null` to disable it.
- Telemetry moved to `@ai-sdk/otel`. Once registered it is on by default and records inputs and outputs.
- All packages are ESM only and require Node 22 or later. On Node 24, a CommonJS `require('ai')` also worked (tested), because `ai` has no top-level await.

### Tools, step limits, abort, approvals, per-step usage

Sources:
- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- https://ai-sdk.dev/docs/agents/loop-control
- https://ai-sdk.dev/docs/agents/tool-approvals
- https://ai-sdk.dev/docs/ai-sdk-core/lifecycle-callbacks
- https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence

```ts
import { streamText, tool, isStepCount, toUIMessageStream, convertToModelMessages, validateUIMessages,
  type UIMessage, type UIMessageChunk, type LanguageModelUsage } from 'ai';
import { z } from 'zod';

const tools = {
  renameTask: tool({
    description: 'Rename the current task',
    inputSchema: z.object({ title: z.string().min(1).max(200) }),
    execute: async ({ title }, { abortSignal, toolCallId }) => {   // ToolExecutionOptions
      abortSignal?.throwIfAborted();
      return { ok: true, title, toolCallId };
    },
  }),
};

const messages = await validateUIMessages({ messages: history, tools });
const result = streamText({
  model: registry.languageModel('openai:fast'),
  instructions: 'You are Simon, the Symplist assistant.',
  messages: await convertToModelMessages(messages, { tools }),        // async in v7
  tools,
  toolApproval: { renameTask: 'user-approval' },  // 'not-applicable' | 'approved' | 'denied' | 'user-approval' | fn
  experimental_toolApprovalSecret: process.env.TOOL_APPROVAL_SECRET,  // HMAC-signs approvals
  stopWhen: isStepCount(10),       // streamText default is isStepCount(1); ToolLoopAgent default is 20
  abortSignal,
  onError: ({ error }) => console.error('simon.stream_error', (error as Error)?.name), // default is console.error(error)
  onStepEnd: ({ stepNumber, model, usage, performance }) => { /* usage: LanguageModelUsage for this step */ },
});
const ui = toUIMessageStream({ stream: result.stream, tools, originalMessages: messages,
  sendReasoning: false, onEnd: async ({ messages: all }) => save(all) });
for await (const chunk of ui) await emit(chunk);   // chunk: UIMessageChunk (plain JSON)
```

- Loop semantics: the loop stops on a non-`tool-calls` finish reason, a tool without `execute`, a tool call that needs approval, or a stop condition. Built-in conditions are `isStepCount`, `hasToolCall` and `isLoopFinished`, and an array means "any of" (https://ai-sdk.dev/docs/agents/loop-control).
- The approval function form is `toolApproval: { tool: async (input, { toolCallId, messages, toolContext, runtimeContext }) => status }`, or one generic `({ toolCall, tools, toolsContext, messages, runtimeContext }) => status`. The object form `{ type: 'denied', reason }` records a reason (https://ai-sdk.dev/docs/agents/tool-approvals).
- Continuation: approval is two calls. The first call emits `tool-approval-request`. The next call includes a `tool-approval-response` in the messages, and the SDK then runs the approved tool before calling the model again (https://ai-sdk.dev/docs/agents/tool-approvals).
  - Verified end to end: nothing executed before approval, the tool executed exactly once after `addToolApprovalResponse`, and the final parts were `step-start, tool-renameTask(output-available), step-start, text`.
  - Verified: with `experimental_toolApprovalSecret` set, changing the tool input after signing produced `AI_InvalidToolApprovalSignatureError` and the tool did not run.
- Abort: aborting the signal ended the UI stream with an `abort` chunk and fired `onAbort` (verified).
- `LanguageModelUsage` in v7 (source `ai/src/types/usage.ts`, docs at https://ai-sdk.dev/docs/ai-sdk-core/lifecycle-callbacks) is `{ inputTokens, inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens }, outputTokens, outputTokenDetails: { textTokens, reasoningTokens }, totalTokens, raw? }`. `onStepEnd` also gives `model: { provider, modelId }`, `finishReason`, and `performance` (`responseTimeMs`, `stepTimeMs`, `outputTokensPerSecond`, ...).

### UI message stream protocol

Sources:
- https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
- https://ai-sdk.dev/docs/ai-sdk-ui/reading-ui-message-streams

- **Chunk types** (`UIMessageChunk`):
  - Message: `start {messageId?, messageMetadata?}`, `finish {finishReason?, messageMetadata?}`, `abort {reason?}`, `error {errorText}`, `message-metadata`
  - Steps: `start-step`, `finish-step`, `reset-step`
  - Text: `text-start`, `text-delta {id, delta}`, `text-end`
  - Reasoning: `reasoning-start`, `reasoning-delta`, `reasoning-end`
  - Tool input: `tool-input-start`, `tool-input-delta {toolCallId, inputTextDelta}`, `tool-input-available {toolCallId, toolName, input}`, `tool-input-error`
  - Approvals: `tool-approval-request {approvalId, toolCallId, isAutomatic?, signature?}`, `tool-approval-response {approvalId, approved, reason?}`
  - Tool output: `tool-output-available {toolCallId, output, preliminary?}`, `tool-output-error`, `tool-output-denied`
  - Sources and files: `source-url`, `source-document`, `file`, `reasoning-file`
  - Other: `data-${name} {id?, data, transient?}`, `custom`
- **HTTP form:** SSE `data: <json>` lines, ending with `data: [DONE]`, plus the header `x-vercel-ai-ui-message-stream: v1`. The header applies only to HTTP backends. A custom transport returns the chunk objects directly, so neither SSE nor the header is needed over a WebSocket.
- **Server producers:** `toUIMessageStream({ stream })`, `createUIMessageStream({ execute({ writer }) })`, `createUIMessageStreamResponse`, `pipeUIMessageStreamToResponse`. `toUIMessageStream` defaults: `sendReasoning: true`, `sendSources: false`, and `onError` returns `'An error occurred.'`, so server error text is masked by default (source `ai/src/ui-message-stream/to-ui-message-stream.ts`).
- **Validation:** `uiMessageChunkSchema` is exported from `ai`. `await uiMessageChunkSchema().validate!(value)` rejected a malformed frame with a ZodError in testing.
- **Server-side assembly:** `readUIMessageStream({ stream })` turns chunks into `UIMessage` snapshots, which is useful in Nest or in tests.

### Custom ChatTransport over WebSocket (client)

Interface source: https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat-transport.ts (linked from https://ai-sdk.dev/docs/ai-sdk-ui/transport, which names WebSockets as a use case and has no built-in WebSocket transport).

```ts
interface ChatTransport<UI_MESSAGE extends UIMessage> {
  sendMessages(options: { trigger: 'submit-message' | 'regenerate-message'; chatId: string;
    messageId: string | undefined; messages: UI_MESSAGE[]; abortSignal: AbortSignal | undefined }
    & ChatRequestOptions /* headers?, body?, metadata? */): Promise<ReadableStream<UIMessageChunk>>;
  reconnectToStream(options: { chatId: string; abortSignal?: AbortSignal } & ChatRequestOptions):
    Promise<ReadableStream<UIMessageChunk> | null>;
}
```

Sketch below. It was typechecked with TS 7.0.2 and run against the `Chat` class from `@ai-sdk/react`. In testing, a full run streamed all text; `chat.stop()` sent `chat.stop`, the fake server halted at chunk 5, and the partial text was kept; a malformed chunk put the chat in `error`.

```ts
export class WebSocketChatTransport implements ChatTransport<UIMessage> {
  private readonly socket: WebSocket;
  constructor(socket: WebSocket) { this.socket = socket; }

  async sendMessages({ chatId, messages, trigger, messageId, abortSignal }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]) {
    const runId = crypto.randomUUID();
    // send only the newest message (or approval-bearing assistant message); the server owns history
    return this.open(runId, () => this.socket.send(JSON.stringify(
      { kind: 'chat.send', runId, chatId, trigger, messageId, message: messages.at(-1) })), abortSignal);
  }
  async reconnectToStream({ chatId, abortSignal }: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0]) {
    const runId = crypto.randomUUID();
    return this.open(runId, () => this.socket.send(JSON.stringify({ kind: 'chat.resume', runId, chatId })), abortSignal);
  }
  private open(runId: string, start: () => void, abortSignal?: AbortSignal) {
    const socket = this.socket; let queue = Promise.resolve(); let done = false;
    let onMessage = (_: MessageEvent) => {};
    const cleanup = () => socket.removeEventListener('message', onMessage);
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        onMessage = ev => {
          const frame = JSON.parse(String(ev.data));
          if (frame.runId !== runId) return;
          queue = queue.then(async () => {            // keep order while validating
            if (done) return;
            if (frame.kind === 'chunk') {
              const parsed = await uiMessageChunkSchema().validate!(frame.chunk);
              parsed.success ? controller.enqueue(parsed.value) : controller.error(parsed.error);
            } else if (frame.kind === 'end') { done = true; cleanup(); controller.close(); }
            else { done = true; cleanup(); controller.error(new Error(frame.message)); }
          });
        };
        socket.addEventListener('message', onMessage);
        abortSignal?.addEventListener('abort', () => {
          if (done) return; done = true;
          socket.send(JSON.stringify({ kind: 'chat.stop', runId })); cleanup(); controller.close();
        }, { once: true });
        start();
      },
      cancel() { done = true; cleanup(); },
    });
  }
}
```

### useChat with the custom transport and approvals

Sources:
- https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat
- https://ai-sdk.dev/docs/agents/tool-approvals

```tsx
const transport = useMemo(() => new WebSocketChatTransport(socket), [socket]);
const { messages, sendMessage, stop, status, addToolApprovalResponse } = useChat<SimonMessage>({
  id: taskId, messages: initialMessages, transport,
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,   // from 'ai'
});
// part.type === 'tool-renameTask' && part.state === 'approval-requested' && !part.approval.isAutomatic
addToolApprovalResponse({ id: part.approval.id, approved: true /*, reason */ });
```

- `useChat` options: `chat`, `transport`, `id`, `messages`, `messageMetadataSchema`, `dataPartSchemas`, `generateId`, `onToolCall`, `sendAutomaticallyWhen`, `onFinish({ message, messages, isAbort, isDisconnect, isError, finishReason })`, `onError`, `onData`, `throttle`, `resume`.
- `useChat` returns: `status: 'submitted' | 'streaming' | 'ready' | 'error'`, `sendMessage`, `regenerate`, `stop`, `resumeStream`, `addToolOutput`, `addToolApprovalResponse`, `setMessages` (`addToolResult` is deprecated).
- `UIMessage<METADATA, DATA_PARTS>` generics type `data-*` parts, for example `p.type === 'data-taskPatch'`. This was typechecked.
- The resumable-streams guide warns that when streams are resumable, a client abort is treated as a disconnect. Real cancellation needs a dedicated stop path (https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams).

### OpenAI Responses provider: gpt-5.6-luna and gpt-5.6-terra

Sources:
- https://ai-sdk.dev/providers/ai-sdk-providers/openai (both IDs are in its model capabilities table and in the `OpenAIResponsesModelId` union)
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-terra

```ts
import { createOpenAI, type OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
const openai = createOpenAI();                       // apiKey defaults to OPENAI_API_KEY (baseURL: OPENAI_BASE_URL)
const luna = openai.responses('gpt-5.6-luna');       // openai('...') also uses the Responses API
providerOptions: { openai: {
  reasoningEffort: 'low',        // 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'; GPT-5.6 supports none..max; default medium
  reasoningSummary: null,        // v7 otherwise defaults to 'detailed' when effort != 'none'
  store: false,                  // default true; provider then adds include: ['reasoning.encrypted_content']
  // parallelToolCalls (default true), safetyIdentifier, promptCacheKey, textVerbosity, serviceTier ...
} satisfies OpenAILanguageModelResponsesOptions }
```

- **OpenAI model pages:**
  - Both models: 1,050,000-token context (922,000 max input), 128,000 max output, knowledge cutoff 2026-02-16, reasoning effort `none|low|medium(default)|high|xhigh|max`, available on the Chat Completions, Responses and Batch endpoints, with function calling, structured outputs and streaming.
  - Pricing: Luna $0.20 input / $0.02 cached / $1.20 output per 1M tokens; Terra $2 / $0.20 / $12.
- **Captured request** (stubbed `fetch`) for the registry's `fast` model:
  - `POST https://api.openai.com/v1/responses` with `model: gpt-5.6-luna`.
  - `instructions` sent as a `developer` role item.
  - `reasoning: { effort: 'low' }`, `store: false`, `include: ['reasoning.encrypted_content']`.
  - `tools` contained only `{ type: 'function', name, parameters }` entries, with `tool_choice: 'auto'`.
  - This capture predates adding `reasoningSummary: null`, so it still showed `summary: 'detailed'`.
- **Top-level `reasoning`:** `reasoning: 'low'` on `gpt-5.6-terra` produced the same `reasoning.effort: 'low'`. Provider options win over the top-level setting and the two are never merged (https://ai-sdk.dev/docs/ai-sdk-core/reasoning). The top-level enum stops at `xhigh`.
- **Hosted tools and programmatic tool calling:** hosted tools are sent only when you add `openai.tools.*` to the tool set. There is no global disable flag.
  - Programmatic tool calling is opt-in: add `openai.tools.programmaticToolCalling()` and set `providerOptions.openai.allowedCallers` on the tool. Its generated JavaScript runs in OpenAI's hosted V8 runtime (https://ai-sdk.dev/providers/ai-sdk-providers/openai and https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling).
  - Provider tools carry `type: 'provider'` (for example `id: 'openai.programmatic_tool_calling'`, `'openai.web_search'`), so a runtime guard can reject them (verified):

```ts
export function assertNoProviderExecutedTools(tools: ToolSet): void {
  for (const [name, def] of Object.entries(tools))
    if (def.type === 'provider') throw new Error(`Provider-executed tool not allowed: ${name} (${def.id})`);
}
```

### Provider registry

Sources:
- https://ai-sdk.dev/docs/ai-sdk-core/provider-management
- https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
- https://ai-sdk.dev/providers/ai-sdk-providers/google-vertex
- https://ai-sdk.dev/providers/ai-sdk-providers/togetherai

```ts
import { createProviderRegistry, customProvider, wrapLanguageModel, defaultSettingsMiddleware } from 'ai';
import { createAmazonBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { createGoogleVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createTogetherAI } from '@ai-sdk/togetherai';

const openaiModel = (id: 'gpt-5.6-luna' | 'gpt-5.6-terra', reasoningEffort: 'low' | 'medium') =>
  wrapLanguageModel({ model: openai.responses(id), middleware: defaultSettingsMiddleware({
    settings: { providerOptions: { openai: { reasoningEffort, reasoningSummary: null, store: false } } } }) });

export const registry = createProviderRegistry({
  openai: customProvider({ languageModels: { fast: openaiModel('gpt-5.6-luna', 'low'),
                                             smart: openaiModel('gpt-5.6-terra', 'medium') } }),
  bedrock: createAmazonBedrockAnthropic(),   // Anthropic Messages API via Bedrock InvokeModel
  vertex: createGoogleVertexAnthropic({ googleAuthOptions: { credentials: JSON.parse(process.env.GOOGLE_VERTEX_CREDENTIALS_JSON ?? '{}') } }),
  together: createTogetherAI(),
});
registry.languageModel('openai:smart');          // default separator ':'; { separator: ' > ' } is configurable
```

- **Verified:** `registry.languageModel('openai:fast')` resolved to provider `openai.responses`, model `gpt-5.6-luna`.
- **Bedrock Anthropic:** requests went to `https://bedrock-runtime.us-east-1.amazonaws.com/model/<id>/invoke`.
- **Together:** requests went to `https://api.together.xyz/v1/chat/completions`.
- **Canonical export names in 7.x source:**
  - `amazonBedrock`/`createAmazonBedrock` (`bedrock` is a deprecated alias)
  - `amazonBedrockAnthropic`/`createAmazonBedrockAnthropic` (`bedrockAnthropic` and `createBedrockAnthropic` are deprecated)
  - `googleVertex`/`createGoogleVertex` (`vertex`, `createVertex` are deprecated)
  - `googleVertexAnthropic`/`createGoogleVertexAnthropic` (`vertexAnthropic`, `createVertexAnthropic` are deprecated)
  - `togetherai`/`createTogetherAI`
  - The provider doc pages still show some of the deprecated aliases.
- **String model IDs:** a bare string such as `model: 'openai/gpt-5.1'` resolves through the global provider, which defaults to the Vercel AI Gateway (https://ai-sdk.dev/docs/ai-sdk-core/provider-management).

### Provider credential environment variables

These were verified in provider docs and in the source's `loadApiKey`/`loadSetting` calls.

| provider | env vars |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`) |
| Amazon Bedrock (incl. `/anthropic`) | `AWS_REGION`, plus `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (optional `AWS_SESSION_TOKEN`, which is ignored when both keys are passed as strings), **or** `AWS_BEARER_TOKEN_BEDROCK` (API key, used before SigV4); `credentialProvider` option for role chains; endpoint overrides `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` / `AWS_ENDPOINT_URL` |
| Google Vertex (incl. `/anthropic`) | `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`; Node auth via google-auth-library (`GOOGLE_APPLICATION_CREDENTIALS` file path, or `googleAuthOptions.credentials`); edge variant uses `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_PRIVATE_KEY_ID`; express mode (Gemini) `GOOGLE_VERTEX_API_KEY` |
| Together AI | `TOGETHER_API_KEY`. `TOGETHER_AI_API_KEY` still works but is **deprecated** and logs a `console.warn` (source `togetherai-provider.ts`) |
| Anthropic (direct) | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (optional `ANTHROPIC_BASE_URL`) |

### Telemetry

Source: https://ai-sdk.dev/docs/ai-sdk-core/telemetry

- `registerTelemetry(new OpenTelemetry())` comes from `ai` and `@ai-sdk/otel`. Once registered, every call emits telemetry and records inputs and outputs by default. Opt out per call with `telemetry: { isEnabled: false }`, or keep telemetry but drop content with `recordInputs: false` / `recordOutputs: false`.
- `telemetry.includeRuntimeContext` and `includeToolsContext` are allowlists; when omitted, nothing from those contexts is included.
- If no integration is registered, telemetry is off globally.
- Lifecycle callbacks (`onStepEnd`, `onLanguageModelCallEnd`, `onToolExecutionEnd`, `onEnd`) work without any integration (https://ai-sdk.dev/docs/ai-sdk-core/lifecycle-callbacks).

### Test helpers

Source: https://ai-sdk.dev/docs/ai-sdk-core/testing

```ts
import { streamText, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
const model = new MockLanguageModelV4({
  doStream: [   // array = one result per call (turn 1 tool call, turn 2 text); function form also supported
    { stream: simulateReadableStream({ chunks: [
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'renameTask', input: '{"title":"Ship beta"}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
                 outputTokens: { total: 20, text: 15, reasoning: 5 } } } ] }) },
    /* ...second result... */
  ],
});
// model.doStreamCalls / model.doGenerateCalls record the LanguageModelV4CallOptions (tools, prompt, providerOptions)
```

- `Chat` from `@ai-sdk/react` can be constructed in plain Node without React rendering. That makes transport, approval and stop tests possible with no browser (verified).
- `simulateReadableStream({ chunks, initialDelayInMs, chunkDelayInMs })` also simulates SSE bodies for HTTP tests.

### MCP client location

Source: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools

- The MCP client is `import { createMCPClient } from '@ai-sdk/mcp'`. Transports are `{ type: 'http' | 'sse', url, headers?, authProvider?, redirect? }`, and the redirect default is now `'error'`.
- `await client.tools()` returns dynamic tools, and `client.close()` should run in `onEnd`.
- The client supports both the stateless MCP `2026-07-28` protocol and the legacy `initialize` handshake.
- It is a client only. Symplist's incoming MCP server needs the MCP server SDK (`@modelcontextprotocol/sdk` 1.30.0, covered by a separate topic).

## Decisions and recommendations

1. **Adopt AI SDK 7 and pin exactly.**
   - `ai` 7.0.101, `@ai-sdk/react` 4.0.104, `@ai-sdk/openai` 4.0.66, `@ai-sdk/amazon-bedrock` 5.0.82, `@ai-sdk/google-vertex` 5.0.82, `@ai-sdk/togetherai` 3.0.49, `zod` 4.6.5.
   - Upgrade `ai` and `@ai-sdk/react` together, because react pins `ai` exactly.
   - Add `minimumReleaseAgeExclude` entries for the packages under 24 hours old, or install after 2026-09-16T04:30Z.
   - Add `@types/json-schema` as a devDependency wherever `skipLibCheck` is false.
2. **TypeScript 7.0.2 is fine** for every package that consumes the AI SDK. Use `module`/`moduleResolution` `nodenext` (worker, Nest) or `bundler` (Next.js).
3. **Agent loop (Trigger worker):**
   - Use `streamText` with `instructions`, an explicit `stopWhen: isStepCount(10)` (build default, tune later), and `abortSignal` wired to run cancellation.
   - Pass `onError` so default `console.error(error)` logging of content is avoided.
   - Pass `toUIMessageStream({ sendReasoning: false })` and persist in `onEnd`.
   - Always `await convertToModelMessages(...)` (it is async even though some doc examples omit `await`) after `validateUIMessages`.
4. **Approvals:**
   - Use call-level `toolApproval`, not `needsApproval`. The approval pause fits durable execution naturally: the run ends at the `tool-approval-request`, and the approval response starts a new run.
   - Set `experimental_toolApprovalSecret` from a new `TOOL_APPROVAL_SECRET` (32 or more random bytes) in the Trigger environment, the same value for every run.
   - Keep the server-side history authoritative. The client sends only the newest message or approval.
5. **Chat transport:**
   - Build a custom `ChatTransport` that sends `UIMessageChunk` JSON frames over the Nest WebSocket (the sketch above).
   - Validate frames with `uiMessageChunkSchema` and map `abortSignal` to a `chat.stop` frame.
   - Implement `reconnectToStream` as "subscribe to the active run for `chatId`" (return `null` when idle) and enable `useChat({ resume: true })`.
   - No SSE header or `DefaultChatTransport`.
6. **OpenAI defaults:**
   - Fast is `openai.responses('gpt-5.6-luna')` with `reasoningEffort: 'low'`; Smart is `openai.responses('gpt-5.6-terra')` with `'medium'`.
   - Set `reasoningSummary: null` and `store: false` on both (encrypted reasoning is carried automatically).
   - Validate the configured effort against `none|low|medium|high|xhigh|max` in app config, because the SDK types `reasoningEffort` as `string`.
   - Consider `safetyIdentifier` (hashed user ID) and `promptCacheKey` (task ID).
7. **No provider-executed tools:**
   - Never add `openai.tools.*`, including `programmaticToolCalling`, `codeInterpreter`, `shell`, `webSearch` and `toolSearch`.
   - Enforce this with `assertNoProviderExecutedTools(tools)` before each call and a unit test.
   - Never pass string model IDs, which would route to the AI Gateway. Always use `registry.languageModel('<provider>:<model>')`.
8. **Registry:**
   - Keys: `openai` (a `customProvider` with `fast`/`smart` aliases wrapped by `defaultSettingsMiddleware`), `bedrock` (`createAmazonBedrockAnthropic`), `vertex` (`createGoogleVertexAnthropic`), `together` (`createTogetherAI`).
   - Use the canonical 7.x names, not the deprecated aliases.
   - Use the top-level `reasoning` setting for Bedrock and Vertex Anthropic models. Together AI is not listed as supporting it.
9. **Credentials:**
   - Update the env CSV: Together is `TOGETHER_API_KEY`, not `TOGETHER_AI_API_KEY`.
   - Bedrock can use `AWS_BEARER_TOKEN_BEDROCK` instead of access keys.
   - Vertex on Trigger has no credentials file, so pass `googleAuthOptions.credentials` parsed from an app-defined secret (for example `GOOGLE_VERTEX_CREDENTIALS_JSON`). Otherwise use the edge variant's `GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY`.
10. **Telemetry without content:**
    - Do not register `@ai-sdk/otel`, since it records prompts and outputs by default.
    - Emit allowlisted numeric fields from `onStepEnd`: `provider`, `modelId`, `stepNumber`, `finishReason`, `usage.inputTokens`, `usage.inputTokenDetails.cacheReadTokens`, `usage.outputTokens`, `usage.outputTokenDetails.reasoningTokens`, `usage.totalTokens`, `performance.responseTimeMs`.
    - Use `onEnd`'s aggregated `usage` for per-run totals.
11. **Tests:**
    - Unit-test tools, approval policy, the provider-tool guard and usage mapping with `MockLanguageModelV4` + `simulateReadableStream`.
    - Test the WebSocket transport with a fake socket and the `Chat` class in Node.
    - Snapshot the OpenAI request body through a stub `fetch` passed to `createOpenAI({ fetch })` to lock `reasoning`, `store` and a function-tools-only `tools` array.

## Risks and open questions

- **Release cadence:** 101 patch releases of `ai` since 2026-06-25, several per day across packages. Pin exactly and upgrade `ai` and `@ai-sdk/react` together. A mismatch installs two copies of `ai` and breaks type identity for `UIMessage` and `ChatTransport`.
- **Experimental API:** `experimental_toolApprovalSecret` may change in a minor release. Without it, the docs warn that a crafted approval in client-supplied history can bypass human-in-the-loop. Server-owned history mitigates this.
- **Custom WebSocket transport is our code:**
  - Ordering, auth on the socket, backpressure, reconnect and resume after deploys, and many chats multiplexed on one socket all need tests.
  - With resume enabled, the docs treat client aborts as disconnects, so Stop must be an explicit server command (`chat.stop`) that cancels the Trigger run and persists partial output.
- **Open (integration):** how chunks travel from the Trigger worker to Nest (Trigger realtime streams, or an HTTP/WS push into Nest) and how to buffer them for resume. Belongs to the Trigger.dev and WebSocket topics.
- **Open (reasoning across turns):** with `store: false` and `sendReasoning: false`, encrypted reasoning items are not carried into the next turn from the persisted UI messages. Decide whether to persist reasoning parts server-side (not shown to the user) for quality and cache hits.
- **Parallel tool calls:** `parallelToolCalls` defaults to true, so one step can request several approvals. `lastAssistantMessageIsCompleteWithApprovalResponses` waits for all of them, and the UI must render each. Consider `parallelToolCalls: false` for Simon if approvals get confusing.
- **Model lists lag:** the provider doc tables list older Claude IDs, the SDK's Vertex Anthropic ID union stops at `claude-sonnet-5`/`claude-fable-5`/`claude-opus-4-8`, and Google's page lists newer models (for example Claude Opus 5, Fable 5.1). Any string is accepted. Check model IDs and regions in the AWS and Google consoles when configuring.
- **OpenAI capability detection** is by model-name parsing: `gpt-5.x` is treated as a reasoning model and gets the developer role (verified). A future ID pattern could need `forceReasoning`.
- **Docs drift:** some examples are out of date. One calls `convertToModelMessages` without `await`, and the reasoning doc's stream loop uses `part.type === 'reasoning'`/`textDelta` instead of `reasoning-delta`/`text`. The web fetch of the OpenAI provider page was truncated, but the raw page does contain the luna/terra rows. Prefer the installed types.
- **TypeScript 7 tooling** (not AI SDK specific): tools that need the compiler API (typescript-eslint typed linting, some bundler plugins) need TypeScript 6 side by side until 7.1.
- **ESM only:** NestJS must run as ESM or rely on Node 24's `require(esm)`. `require('ai')` works today, but TS 7 rejects legacy `node10` resolution (`tsc` 7.0.2 reports TS5108: "Option 'moduleResolution=node10' has been removed").
- **Default logging:** `streamText`'s default `onError` calls `console.error(error)`, and provider errors can include request details. Always pass `onError`.
