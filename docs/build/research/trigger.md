# Trigger research (verified 2026-09-15)

Scope: Trigger.dev v4 for Symplist's durable work. That covers Simon chat sessions driven from NestJS, realtime streams, reminder schedules, triggering and idempotency, machines, CI deploys and env sync, pnpm workspace bundling, unit tests, and triggering dev runs from Node.

Method:
- Versions come from `npm view`.
- API facts come from the official docs, fetched as raw Markdown (`https://trigger.dev/docs/<page>.md`).
- Every snippet under "Verified APIs" either quotes the docs or was typechecked with TypeScript 7.0.2 (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `lib: ["ES2023"]`, `types: ["node"]`) in a throwaway pnpm 12.4.2 workspace on Node 24.15.0.
- Experiments that ran and passed:
  - typecheck on TS 7.0.2 and TS 6.0.3
  - vitest 5.0.1 unit tests of a task run function and of a `chat.agent` on `ai@7.0.101`
  - an offline `deploy`-target bundle using the CLI's own `buildWorker`
  - a cron parse with `cron-parser@4.9.0`
  - a live trigger call with an invalid key, which returned a 401
- Nothing was installed into the Symplist repository.

## Versions

| package | version | peer/engine notes |
| --- | --- | --- |
| `@trigger.dev/sdk` | 4.6.0 (`latest`; v4.6.0 released 2026-09-14) | engines `node >=18.20.0`. Peers: `zod ^3.25.56 \|\| ^4.0.0` (required); `ai ^5.0.0 \|\| ^6.0.0 \|\| >=7.0.0-canary <8`, `@ai-sdk/otel >=1.0.0-0 <2`, `react ^18.0 \|\| ^19.0` (all three optional). Exports `.`, `./ai`, `./ai/test`, `./chat`, `./chat/react`, `./chat-server`, each with `import` and `require` conditions (CJS and ESM both load on Node 24). |
| `trigger.dev` (CLI) | 4.6.0 | engines `node >=18.20.0`. Bundles with `esbuild ^0.23.0`. Pins `zod 4.5.4` and `@depot/cli 0.0.1-cli.2.80.0` (needs the existing `allowBuilds` entry). CI deploy fails on any `@trigger.dev/*` version mismatch. |
| `@trigger.dev/build` | 4.6.0 | Optional peers `typescript >=5.0.0` and `@typescript/typescript6 ^6.0.0`. Depends on `tsconfck 3.1.3`, whose optional peer `typescript ^5.0.0` shows as a pnpm peer warning with TS 7. The repo already shows this warning; it is harmless. |
| `@trigger.dev/core` | 4.6.0 | Peer `zod ^3.25.56 \|\| ^4.0.0`. Add as a pinned devDependency only if tests import `resourceCatalog`. |
| `@trigger.dev/react-hooks` | 4.6.0 | Peers `react`, `react-dom ^18 \|\| ^19`. Not needed because Nest owns realtime. |
| `ai` | 7.0.101 | engines `node >=22`; peer `zod ^3.25.76 \|\| ^4.1.8`. Inside the SDK's `ai` peer range. |
| `@ai-sdk/otel` | 1.0.101 | engines `node >=22`. Install next to `ai@7` so model-call spans appear in run traces. |
| `@ai-sdk/provider` | 4.0.14 | engines `node >=22`. Only needed to type mock stream parts in tests. |
| `zod` | 4.6.5 | Trigger.dev 4.6 uses Zod 4 by default. |
| `typescript` | 7.0.2 | `latest`. |
| `@typescript/typescript6` | 6.0.2 | Only for the `emitDecoratorMetadata` build extension, which Symplist does not need. |
| `@node-rs/argon2` | 2.2.1 | engines `node >= 10`. The main package loads one of 13 per-platform `optionalDependencies` binaries. |
| `vitest` | 5.0.1 | engines `node ^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`. |
| Trigger runtime `node-24` | Node 24.18.0 | From the config docs. `node-26` is Node 26.4.0. |

### TypeScript 7 verdict

**Works with TypeScript 7.0.2, with no fallback needed for Symplist.** Evidence:

- The SDK, the `ai@7` chat agent, the schedules and trigger APIs, and the `trigger.config.ts` below all typecheck with `tsc` 7.0.2 when `skipLibCheck: true` (the repo's current setting).
- With `skipLibCheck: false`, 14 errors come from published declarations. Examples: `@trigger.dev/sdk/dist/esm/v3/ai.d.ts` "Cannot find name 'CHAT_LOCAL_KEY'", `@trigger.dev/core` missing `ts-essentials`, and `@ai-sdk/provider` missing `json-schema` types. **TypeScript 6.0.3 reports the identical 14 errors**, so they are SDK packaging defects and have nothing to do with TS 7. Keep `skipLibCheck: true`.
- The CLI never calls the TypeScript compiler API to bundle; it uses esbuild. The only TS-API consumer is `emitDecoratorMetadata()`. Its loader (`@trigger.dev/build/dist/esm/extensions/internal/loadTypescript.js`) tries `typescript`, then `@typescript/typescript6`, and otherwise throws "requires the TypeScript JavaScript compiler API, which TypeScript 7 does not expose". Docs: https://trigger.dev/docs/config/extensions/emitDecoratorMetadata. Symplist tasks use no decorators (NestJS lives on Render), so the extension and the TS 6 compatibility package are unnecessary.

## Verified APIs

### 1. AI chat: sessions driven from the NestJS backend

**What a session is.** A durable row keyed by your `externalId` (use the chat id). It holds two S2-backed streams: `.in` (clients to task) and `.out` (task to clients). It also tracks `currentRunId`. Runs come and go through idle suspend, continuation after exit, and version upgrade; clients keep addressing the same id. `chat.agent` sessions have `type: "chat.agent"`, and the `.out` `seq_num` increases monotonically across the whole session, so one cursor resumes across turns and runs.
- https://trigger.dev/docs/ai-chat/sessions
- https://trigger.dev/docs/ai-chat/how-it-works
- https://trigger.dev/docs/ai-chat/client-protocol

**Agent task (worker).** `chat.agent` from `@trigger.dev/sdk/ai`. Use the managed `streamText` passed into `run`, not the one imported from `ai`; the imported one skips compaction, steering and injection. Typechecked with `ai@7.0.101`.
- https://trigger.dev/docs/ai-chat/quick-start
- https://trigger.dev/docs/ai-chat/backend

```ts
import { chat } from "@trigger.dev/sdk/ai";
import { stepCountIs, type LanguageModel } from "ai";
import { z } from "zod";

type ClientData = { userId: string; model?: LanguageModel };

export const simon = chat
  .withClientData({
    schema: z.custom<ClientData>((v) => !!v && typeof v === "object" && "userId" in (v as object)),
  })
  .agent({
    id: "simon-chat",
    machine: "micro",
    maxDuration: 900,
    run: async ({ messages, clientData, signal, streamText }) =>
      streamText({
        model: clientData?.model ?? "openai/gpt-5.6-luna",
        messages,
        abortSignal: signal,
        stopWhen: stepCountIs(8),
      }),
  });
```

Relevant `chat.agent` options and defaults (https://trigger.dev/docs/ai-chat/reference):
- `idleTimeoutInSeconds` defaults to 30. The run stays warm that long, then suspends.
- `turnTimeout` defaults to `"1h"`. `maxTurns` defaults to 100.
- `oomMachine` is off by default.
- Generic `retry` is not exposed.
- `chat.agent` runs use `retry: { maxAttempts: 1 }` and never retry an unhandled failure (https://trigger.dev/docs/ai-chat/error-handling).
- The `signal` passed to `run` fires on stop or cancel. `cancelSignal` covers run cancel, expiry and exceeding `maxDuration`.

**Sending from the backend: `AgentChat`** (`@trigger.dev/sdk/chat`, https://trigger.dev/docs/ai-chat/server-chat):
- Uses the ambient `TRIGGER_SECRET_KEY`.
- On first use it calls `sessions.start` (idempotent on `(env, externalId)`) with `basePayload.trigger: "preload"`, then appends one message per `.in` record.
- `sendMessage` returns a `ChatStream` that is async-iterable over AI SDK `UIMessageChunk`s. It also offers `text()`, `result()`, `messages()` and `.stream`.

Typechecked:

```ts
import { AgentChat } from "@trigger.dev/sdk/chat";
import type { simon } from "./trigger/simon.ts"; // type-only import: no task code in Nest

export async function sendChat(chatId: string, userId: string, text: string, savedCursor?: string) {
  const agentChat = new AgentChat<typeof simon>({
    agent: "simon-chat",
    id: chatId, // becomes the Session externalId
    clientData: { userId }, // sent as payload.metadata on every record, validated by the agent
    session: savedCursor ? { lastEventId: savedCursor } : undefined,
    // Types require basePayload even though the docs describe Partial<SessionTriggerConfig>.
    triggerConfig: { basePayload: {}, machine: "micro", tags: [`user:${userId}`] },
    onTriggered: ({ runId }) => { /* store current run id for telemetry */ },
    onTurnComplete: ({ lastEventId }) => { /* persist resume cursor per chat */ },
  });
  const stream = await agentChat.sendMessage(text, { abortSignal: AbortSignal.timeout(300_000) });
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") { /* forward chunk.delta over the Nest WebSocket */ }
  }
  return agentChat.session.lastEventId;
}
```

**Resume from a cursor.**
- Construct `AgentChat` with `session: { lastEventId }`, then call `reconnect(abortSignal?)`. It returns `ReadableStream<UIMessageChunk> | null`. It sends `X-Peek-Settled` so an already-settled stream closes quickly. Do not call it right after `sendMessage()`.
- Source: `AgentChat` declarations in 4.6.0 and https://trigger.dev/docs/ai-chat/client-protocol.
- In SDK source, a non-empty `session` option marks the instance as started, so `stop()`, `close()` and `reconnect()` work from a fresh stateless request. Without it those calls are no-ops (they return early when not started).

```ts
const agentChat = new AgentChat<typeof simon>({ agent: "simon-chat", id: chatId, clientData: { userId }, session: { lastEventId } });
await agentChat.stop();                  // abort the current streamText; run stays alive for the next turn
const resumed = await agentChat.reconnect(); // ReadableStream<UIMessageChunk> | null
```

**Stop, cancel and close are four different levels:**

| Action | API | Effect | Source |
| --- | --- | --- | --- |
| Stop the turn | `agentChat.stop()`, i.e. `.in` record `{ "kind": "stop" }` | `streamText` aborts, a `turn-complete` is emitted, the run idles | https://trigger.dev/docs/ai-chat/client-protocol |
| End the loop | `agentChat.close()`, i.e. `.in` record `{ kind: "message", payload: { chatId, trigger: "close" } }` | The agent exits its loop gracefully. Without it, the agent exits after its idle and suspend timeouts. | https://trigger.dev/docs/ai-chat/server-chat |
| Cancel the run | `runs.cancel(runId)` (run id from `sessions.retrieve(chatId).currentRunId`) | Execution stops with no retry and child runs are cancelled. The next message boots a continuation run with "recovery boot", which keeps the partial response as context. | https://trigger.dev/docs/runs and https://trigger.dev/docs/ai-chat/patterns/recovery-boot |
| Close the session | `sessions.close(chatId, { reason })` | Terminal and idempotent. Idle agents exit on next wake; later `.in` appends get HTTP 409 `code: "session_closed"`. | https://trigger.dev/docs/ai-chat/sessions |

**Raw `sessions` API** (same channels without `AgentChat`, https://trigger.dev/docs/ai-chat/sessions). Typechecked:

```ts
import { sessions, auth } from "@trigger.dev/sdk";

const row = await sessions.retrieve(chatId); // accepts externalId or session_* id
row.currentRunId; row.closedAt;

const session = sessions.open(chatId); // no network until a method is called
const out = await session.out.read<{ type: string; delta?: string }>({
  lastEventId,                // resume after this seq_num
  timeoutInSeconds: 60,       // long-poll, max 600
  signal: AbortSignal.timeout(30_000),
  onPart: (p) => { /* p.id is the cursor to persist */ },
  onControl: (event) => { /* turn-complete / upgrade-required control records */ },
});
for await (const chunk of out) { /* UIMessageChunk-shaped data records */ }

for await (const s of sessions.list({ type: "chat.agent", status: "ACTIVE", limit: 20 })) { /* ... */ }

const pat = await auth.createPublicToken({
  scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
  expirationTime: "1h",
});
```

- `session.in.send(value)` resolves to `void` in the SDK types. The HTTP endpoint returns `{ ok: true, seq }`, but the SDK does not surface `seq` (source: `sessions.d.ts`).
- For `chat.agent`, the `.in` wire shape is `{ kind: "message", payload: ChatTaskWirePayload }` or `{ kind: "stop", message? }`. Send only the new message, never the history (https://trigger.dev/docs/ai-chat/client-protocol):

```json
{ "kind": "message", "payload": { "message": { "id": "msg-2", "role": "user", "parts": [{ "type": "text", "text": "Tell me more" }] }, "chatId": "conversation-123", "trigger": "submit-message", "metadata": { "userId": "user-456" } } }
```

HTTP endpoints (https://trigger.dev/docs/management/sessions/channels):
- `POST /realtime/v1/sessions/{session}/in/append`. The optional `X-Part-Id` header makes the append idempotent.
- `GET /realtime/v1/sessions/{session}/out` over SSE. Takes `Last-Event-ID` and `Timeout-Seconds` (1 to 600; default 60).
- `GET .../out/records?afterEventId=` drains records without streaming.
- Reading `.in` and appending to `.out` require a secret key. Since 4.6.0, public tokens get a 403 on `.in` reads (https://trigger.dev/changelog/v4-6-0).
- Records are capped at about 1 MiB (413).
- A client should treat `turn-complete` as its own only when `session-in-event-id >= seq` of its append.

**Frontend transport, for reference only** (https://trigger.dev/docs/ai-chat/frontend):
- `useTriggerChatTransport` from `@trigger.dev/sdk/chat/react`, with `accessToken` and `startSession` callbacks. Server side it uses `chat.createStartSessionAction(taskId)` and `auth.createPublicToken`.
- Symplist does not use it, because Nest owns the WebSocket.

**AI SDK compatibility** (https://trigger.dev/docs/ai-chat/reference#compatibility):
- The docs list `ai` v5, v6 and v7. They still call v7 "canary/beta upstream", which is outdated: `ai@7.0.101` is `latest` on npm.
- The SDK peer range (`>=7.0.0-canary <8`) includes it.
- On v7, install `@ai-sdk/otel` 1.x. The SDK auto-registers it; set `TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0` to opt out.
- Verified: `mockChatAgent` with `MockLanguageModelV4` from `ai/test` streamed a reply through the managed `streamText` on `ai@7.0.101`, and the test passed.

**Transcript storage** (https://trigger.dev/docs/ai-chat/transcript-storage):
- By default the whole `UIMessage[]` conversation goes to Trigger's object storage after each change.
- A custom `storage: TranscriptStorage` (`load`, `save`, optional `loadContext`) keeps it in your own database. The types are exported from `@trigger.dev/sdk/ai`.

### 2. Realtime streams (v2) consumed from the backend

- Streams v2 is the default from SDK 4.1.0. Streams have unlimited length, 28-day retention and a 300 MiB maximum size.
- Define each stream once and read it by run id. `read` options: `timeoutInSeconds`, `startIndex` (resume), `from: "beginning" | "latest"`, `signal`.
- Sources: https://trigger.dev/docs/tasks/streams and https://trigger.dev/docs/realtime/backend/streams

```ts
// shared: apps/worker/src/trigger/streams.ts
import { streams, type InferStreamType } from "@trigger.dev/sdk";
export const progressStream = streams.define<{ step: string; percent: number }>({ id: "progress" });
export type ProgressPart = InferStreamType<typeof progressStream>;

// task side
const { waitUntilComplete } = progressStream.pipe(readable); // or progressStream.append({...}) / .writer({ execute })
await waitUntilComplete();

// backend side (typechecked)
const s = await progressStream.read(runId, {
  timeoutInSeconds: 120,
  startIndex: lastIndex === undefined ? undefined : lastIndex + 1,
  signal: AbortSignal.timeout(60_000),
});
for await (const part of s) { /* part.step, part.percent */ }
```

Run status, metadata and tag changes use an async iterator (https://trigger.dev/docs/realtime/backend/subscribe):

```ts
import { runs } from "@trigger.dev/sdk";
for await (const run of runs.subscribeToRun<typeof commitDocument>(runId)) {
  if (run.isCompleted) break; // completes on its own when the run finishes
}
```

Input streams send data into a running run with `streams.input<T>({ id })` then `.send(runId, data)`. Sending to a finished run fails, and each send is capped at 1 MB (https://trigger.dev/docs/tasks/streams#input-streams).

### 3. Scheduled tasks

Source: https://trigger.dev/docs/tasks/scheduled

**Declarative schedule.**
- A string `cron` runs in UTC. The object form takes `pattern`, `timezone` (IANA, DST-aware), optional `window`, and `environments`, which defaults to all.
- It syncs when you run `trigger dev` or `trigger deploy`.
- Payload fields: `timestamp`, `lastTimestamp`, `timezone`, `scheduleId`, `externalId`, `upcoming`.
- Typechecked:

```ts
import { schedules, logger } from "@trigger.dev/sdk";

export const reminderSweep = schedules.task({
  id: "reminder-sweep",
  cron: { pattern: "0,30,45 * * * *", timezone: "UTC", environments: ["PRODUCTION", "STAGING"] },
  ttl: "10m",            // expire a stacked run instead of queueing stale sweeps
  queue: { concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    logger.info("sweep", { at: payload.timestamp.toISOString(), env: ctx.environment.type });
  },
});
```

(`queue: { concurrencyLimit: 1 }` is from https://trigger.dev/docs/queue-concurrency.)

**Is `"0,30,45 * * * *"` valid?**
- The syntax docs show five fields and no seconds.
- The server validator (`apps/webapp/app/v3/schedules.ts`, https://github.com/triggerdotdev/trigger.dev/blob/main/apps/webapp/app/v3/schedules.ts) rejects more than 5 parts and otherwise accepts anything `cron-parser` `parseExpression` accepts. The webapp depends on `cron-parser ^4.9.0`.
- Verified locally with `cron-parser@4.9.0`: minutes `[0, 30, 45]`, next runs 10:30, 10:45, 11:00, 11:30 UTC.

**Free-plan rule.** Schedules created on a free-plan org may fire at most once an hour and get a 60-minute minimum window, in every environment including Development. "0,30,45" has a 15-minute gap and would be rejected. Paid plans (Hobby included) are not restricted.
- https://trigger.dev/docs/tasks/scheduled#free-plan-minimum-window
- https://github.com/triggerdotdev/trigger.dev/blob/main/apps/webapp/app/v3/validateMinimumCronInterval.ts

**Imperative schedules.**
- `schedules.create({ task, cron, timezone, externalId, deduplicationKey, window })`, plus `retrieve`, `list`, `update`, `deactivate`, `activate`, `del` and `timezones`.
- `deduplicationKey` is per project, not per environment, so include the env name in the key.
- Limits: Free 10, Hobby 100, Pro 1,000+ schedules per project (https://trigger.dev/docs/limits).

**Per-environment behavior.**
- Dev schedules fire only while the dev CLI is running.
- Staging and prod fire only tasks in the current (latest) deployment.
- Declarative schedules cannot be edited or deleted in the dashboard.

### 4. Triggering, batching, idempotency, TTL, cancel, metadata

Sources:
- https://trigger.dev/docs/triggering
- https://trigger.dev/docs/idempotency
- https://trigger.dev/docs/runs
- https://trigger.dev/docs/runs/metadata

Typechecked backend code:

```ts
import { configure, tasks, batch, runs, idempotencyKeys, BatchTriggerError } from "@trigger.dev/sdk";
import type { commitDocument } from "./trigger/documents.ts"; // type-only

configure({ secretKey: process.env.TRIGGER_SECRET_KEY }); // optional when the env var is set

const handle = await tasks.trigger<typeof commitDocument>(
  "commit-document",
  { taskId, revision },
  {
    idempotencyKey: `commit:${taskId}:${revision}`, // outside a task every scope behaves as global
    idempotencyKeyTTL: "1d",                         // default 30 days; s/m/h/d units
    ttl: "30m",                                      // expire if not started in time
    tags: [`task:${taskId}`],
    metadata: { requestedBy: "api" },
    machine: "small-2x",
    maxAttempts: 3,
  },
);
const run = await runs.retrieve<typeof commitDocument>(handle.id); // run.status, run.output, run.metadata

await tasks.batchTrigger<typeof commitDocument>(
  "commit-document",
  ids.map((id) => ({ payload: { taskId: id, revision: 1 }, options: { idempotencyKey: `c:${id}` } })),
);
await batch.trigger<typeof commitDocument | typeof reminderSweep>([{ id: "commit-document", payload: { taskId: "x", revision: 2 } }]);
// catch (e) { if (e instanceof BatchTriggerError && e.isRateLimited) wait(e.retryAfterMs) }

await runs.cancel(runId);                      // no retry; in-progress children cancelled; no-op if completed
await runs.reschedule(runId, { delay: "1h" }); // only for DELAYED runs
await idempotencyKeys.reset("commit-document", key); // allow re-trigger after success/cancel
```

**Idempotency semantics** (https://trigger.dev/docs/idempotency):
- Keys are scoped to task plus environment.
- A raw string defaults to `run` scope inside a task (changed in 4.3.1). From backend code all scopes act as global.
- A failed run clears its key. Successful and canceled runs keep it until the TTL expires or `idempotencyKeys.reset` is called.
- Keys may be up to 2048 characters; `idempotencyKeys.create()` returns a 64-char hash.
- Batches allow one key per item or one for the whole batch.

**TTL** (https://trigger.dev/docs/runs#time-to-live-ttl):
- Precedence is trigger, then task `ttl`, then config `ttl`. `ttl: 0` opts out.
- Dev runs get 10 minutes by default.
- Cloud staging and prod get 14 days by default and are clamped to 14 days at most.
- With `delay`, the TTL clock starts at enqueue.

**Metadata** (https://trigger.dev/docs/runs/metadata):
- Set via `metadata.set/append/increment/...` inside a run (no-op outside one), or the `metadata` option at trigger time.
- Also `metadata.parent` and `metadata.root`, plus `await metadata.flush()`.
- Maximum size is 256KB. Not propagated to child runs.

**Payload limits:** 3MB per trigger payload and 10MB per output; 1,000 items per batch (https://trigger.dev/docs/limits).

### 5. Machines, OOM retry, maxDuration

Sources: https://trigger.dev/docs/machines and https://trigger.dev/docs/runs/max-duration

**Presets** (vCPU / GB):

| Preset | vCPU | Memory (GB) |
| --- | --- | --- |
| `micro` | 0.25 | 0.25 |
| `small-1x` (default) | 0.5 | 0.5 |
| `small-2x` | 1 | 1 |
| `medium-1x` | 1 | 2 |
| `medium-2x` | 2 | 4 |
| `large-1x` | 4 | 8 |
| `large-2x` | 8 | 16 |

Every preset has 10GB disk. The machine can be set in config, per task, or per trigger (`{ machine }`).

**OOM retry.**
- `retry.outOfMemory.machine` retries only on OOM and does not change the machine for new runs.
- `throw new OutOfMemoryError()` signals OOM explicitly.
- Typechecked:

```ts
import { task } from "@trigger.dev/sdk";
export const commitDocument = task({
  id: "commit-document",
  machine: "small-1x",
  maxDuration: 600,
  retry: { maxAttempts: 3, outOfMemory: { machine: "medium-1x" } },
  run: async (payload: { taskId: string; revision: number }, { ctx }) => { /* ctx.attempt.number */ },
});
```

**`chat.agent` OOM behavior** (https://trigger.dev/docs/ai-chat/patterns/oom-resilience):
- `chat.agent` has no generic retry.
- `oomMachine: "<preset>"` turns on exactly one OOM retry. Tools that were mid-execution re-run from scratch, and the docs say to make them idempotent.
- Without `oomMachine`, an OOM fails the run.

**maxDuration.**
- A config default is required; the minimum is 5 seconds. Override per task or per trigger; `timeout.None` disables the limit.
- It is measured as CPU time per attempt and excludes `wait.for`, `triggerAndWait` and `batchTriggerAndWait`.
- When it is exceeded, `cleanup`, `onSuccess` and `onFailure` do not run.

### 6. Deploying from GitHub Actions and syncing env vars

**CLI** (https://trigger.dev/docs/cli-deploy-commands):
- `trigger deploy [path]`
- `--env prod|staging|preview` (default `prod`)
- `--external-id <sha>`: an idempotent deploy per id. It does not rebuild after only env var changes; use `--force` or an empty commit.
- `--skip-sync-env-vars`, `--dry-run`, `--skip-promotion`, `--native-build`, `--build-logs full`
- Non-interactive auth reads `TRIGGER_ACCESS_TOKEN` (https://trigger.dev/docs/github-actions).
- `TRIGGER_ACCESS_TOKEN` can be a Personal Access Token or an environment API key with the "Deploy only" preset. The key must belong to the target environment, and setting it overrides a saved CLI login (https://trigger.dev/docs/apikeys).
- Keep the CLI as a pinned devDependency and deploy through it; CI fails on version mismatches.

Workflow sketch:
- The Trigger step follows the docs.
- Action tags are the latest GitHub releases on 2026-09-15: `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `pnpm/action-setup` v6.1.0. The last one reads `packageManager` when `version` is omitted and supports pnpm 12.
- The CI research should confirm the non-Trigger steps.

```yaml
name: Deploy Trigger.dev (prod)
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: pnpm install --frozen-lockfile
      - name: Deploy tasks
        env:
          TRIGGER_ACCESS_TOKEN: ${{ secrets.TRIGGER_ACCESS_TOKEN }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }} # read by syncEnvVars below
        run: pnpm --filter @symplist/worker exec trigger deploy --env prod --external-id ${{ github.sha }}
```

**`syncEnvVars`** (https://trigger.dev/docs/config/extensions/syncEnvVars and https://trigger.dev/docs/deploy-environment-variables):
- The callback runs at deploy time. It receives `ctx.environment`, `ctx.projectRef` and `ctx.env`.
- It returns a record or an array. Only the array form supports `isSecret: true`; secrets are redacted and cannot be revealed later.
- It has no effect under `trigger dev`, which loads `.env`, `.env.development`, `.env.local`, `.env.development.local` and `dev.vars`.
- In CLI 4.6.0 source (`commands/deploy.js`), the sync imports with `override: true`. It upserts only the returned keys and never deletes removed ones.
- Typechecked, and verified with an offline `deploy` bundle: the manifest put `CLOUDFLARE_ACCOUNT_ID` in `sync.env` and `RESEND_API_KEY` in `sync.secretEnv`.

```ts
import { defineConfig } from "@trigger.dev/sdk";
import { aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_rryekrktnjnrdzvabzqd",
  runtime: "node-24",
  dirs: ["./src/trigger"],
  maxDuration: 900,
  machine: "micro",
  build: {
    external: ["@node-rs/argon2"], // only if a task imports it; see section 7
    extensions: [
      aptGet({ packages: ["git"] }),
      syncEnvVars(async () => {
        const names = ["CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "RESEND_API_KEY"] as const;
        return names
          .filter((name) => process.env[name])
          .map((name) => ({ name, value: process.env[name]!, isSecret: name !== "CLOUDFLARE_ACCOUNT_ID" }));
      }),
    ],
  },
});
```

**Version skew protection** (optional, https://trigger.dev/docs/deployment/version-skew-protection):
- Requires SDK and CLI 4.5.12 or later.
- Deploy with `--external-id <sha>` and set `TRIGGER_EXTERNAL_DEPLOYMENT_ID` to the same value in the triggering app. Alternatively set `TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION=1` so the SDK reads `RENDER_GIT_COMMIT`, which Render exposes at runtime.
- Runs wait for a matching deployment and expire after 1 hour if none arrives.
- Chat sessions store the pin on the session.
- A `paths:` filter on the deploy workflow breaks the `github.sha` contract.

### 7. pnpm workspace packages and native dependencies in tasks

Sources:
- https://trigger.dev/docs/config/config-file#external
- https://trigger.dev/docs/troubleshooting
- https://trigger.dev/docs/manual-setup#monorepo-setup

**What happens by default.**
- All code is bundled by esbuild.
- `build.external` entries are left as imports and added to a generated `package.json` at the version found in `node_modules`, then `npm i`-ed in the image.
- `autoDetectExternal` defaults to true. It marks as external any resolved package whose entry ends in `.wasm`/`.node`, whose `files`/`main`/`module`/`browser` list native files, or that has `binding.gyp`. Source: CLI `dist/esm/build/externals.js`.

Experiment: `@exp/worker` imports `@exp/shared` (`workspace:*`, private, TS-source `exports`), which imports `@node-rs/argon2`. The offline `deploy` bundle came out as follows:
- **Workspace package:** inlined into `documents.mjs`, with no install needed.
- **With `build.external: ["@node-rs/argon2"]`:** the generated `package.json` has `"@node-rs/argon2": "2.2.1"`. The bundle keeps `import { hash, verify } from "@node-rs/argon2"`. The image's `npm i` then fetches the Linux binary through optionalDependencies.
- **Without it (auto-detect only):** the generated `package.json` has `"@node-rs/argon2-darwin-arm64": "2.2.1"`, the build host's platform binary. That image would fail on Linux, or depend on the CI runner's platform.
- Unit tests calling `hash`/`verify` through the workspace package passed locally.

Rules that follow:
1. Never list a workspace package in `external`, and never let one be detected as external. A private `0.0.0` package cannot be `npm i`-ed. Keep native code out of workspace packages, or list the native npm dependency explicitly.
2. Always name napi-rs and other native packages (such as `@node-rs/argon2`) explicitly in `build.external`.
3. An import of a devDependency or unlisted package still resolves from the pnpm store at bundle time. Only externals need versions in `node_modules`.

### 8. Unit testing task run functions locally

**Preferred:** keep logic in plain functions and inject dependencies. The repo already does this (`runtime-report.ts` with `vi.fn<ExecFileFn>()`).

**When the task wrapper itself needs testing** (https://trigger.dev/docs/ai-chat/testing):
- Import `@trigger.dev/sdk/ai/test` **first**. It installs an in-memory resource catalog so `task()` and `chat.agent()` register their run functions.
- `runInMockTaskContext` supplies `ctx`, in-memory metadata and streams, and input/output drivers.
- The docs example `myTask.fns.run(...)` does **not** work in 4.6.0: `fns` is neither on the `Task` type nor on the runtime object (a TS2339 error, confirmed at runtime). Get the run function from the catalog instead. This is the same lookup `mockChatAgent` uses internally.
- Passing vitest 5.0.1 test (requires `@trigger.dev/core@4.6.0` as a devDependency):

```ts
import { runInMockTaskContext } from "@trigger.dev/sdk/ai/test"; // must be first
import { resourceCatalog } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { commitDocument } from "./trigger/documents.ts";

describe("commitDocument run function", () => {
  it("runs offline inside a mock task context", async () => {
    const run = resourceCatalog.getTask(commitDocument.id)?.fns.run;
    await runInMockTaskContext(
      async ({ ctx }) => {
        const result = await run!({ taskId: "t1", revision: 3 }, { ctx, signal: new AbortController().signal } as never);
        expect(result).toMatchObject({ greeting: "hello t1", ok: true });
      },
      { ctx: { run: { id: "run_test" }, attempt: { number: 1 } } },
    );
  });
});
```

**Chat agent test** (passing on `ai@7.0.101`):
- `mockChatAgent(simon, { chatId, clientData: { userId, model } })`
- `harness.sendMessage({ id, role: "user", parts: [...] })`, then assert on `turn.chunks`
- `harness.sendStop()`, `harness.sendAction()`, and `harness.close()` in `finally`
- Inject `MockLanguageModelV4` from `ai/test` (v7) through `clientData`. The docs show `MockLanguageModelV3`, which is the v6 name; `ai@7` exports both.
- The harness makes no network calls, and one agent registry exists per process (https://trigger.dev/docs/ai-chat/testing).

### 9. Triggering a dev task from Node with `TRIGGER_SECRET_KEY`

Sources: https://trigger.dev/docs/apikeys and https://trigger.dev/docs/cli-dev-commands

1. Run `pnpm --filter @symplist/worker dev`, i.e. `trigger dev`.
   - Runs execute only while it is connected.
   - Run one dev instance per project and branch; a second instance splits the queue (https://trigger.dev/docs/troubleshooting).
   - `trigger dev --branch <name>` or `TRIGGER_DEV_BRANCH` isolates parallel sessions (https://trigger.dev/docs/deployment/dev-branches).
2. In the Node process, set `TRIGGER_SECRET_KEY=tr_dev_...` from your own Development environment. A key belongs to exactly one environment. For a named dev or preview branch, also set `TRIGGER_PREVIEW_BRANCH`.
3. Trigger with a type-only import. Probed live: an invalid key throws `AuthenticationError` (an `ApiError` subclass) with `status: 401` and message "Invalid API key".

```ts
import { configure, tasks, AuthenticationError } from "@trigger.dev/sdk";
configure({ secretKey: process.env.TRIGGER_SECRET_KEY });
try {
  const handle = await tasks.trigger("symplist-healthcheck", {}, { ttl: "5m", tags: ["local"] });
} catch (error) {
  if (error instanceof AuthenticationError) { /* wrong or missing tr_dev key */ }
}
```

Dev runs expire after 10 minutes if no dev CLI picks them up (https://trigger.dev/docs/triggering#ttl). Triggering a task that has not been deployed leaves the run "Waiting for deploy" (https://trigger.dev/docs/runs).

## Decisions and recommendations

1. **Pin everything Trigger-related to 4.6.0** and bump them together: `@trigger.dev/sdk`, `@trigger.dev/build`, `trigger.dev`, and `@trigger.dev/core` if tests use it. Keep TypeScript 7.0.2 and `skipLibCheck: true`. Do not add `@typescript/typescript6` and do not use `emitDecoratorMetadata` in the worker.
2. **Simon chat runs on `chat.agent`, driven from Nest with `AgentChat`.**
   - Nest imports the agent by type only.
   - Nest persists `lastEventId` per chat (from `onTurnComplete` or `agentChat.session`).
   - Each Nest request constructs `AgentChat` with `session: { lastEventId }`, so stop, reconnect and close work statelessly.
   - Nest forwards `UIMessageChunk`s to the browser over its own WebSocket. The browser never receives a Trigger token.
   - Use `sessions.retrieve` for `currentRunId`, `runs.cancel` for a hard interrupt, and `sessions.close` when a task or its chat is deleted.
   - Pass `triggerConfig: { basePayload: {}, ... }` until the types match the docs.
3. **Chat OOM policy matches decision A3.** Leave `oomMachine` unset, since the default is one attempt and no retry. Surface failure via `onFailure` or `onTurnComplete` status as "interrupted". Implement Retry as an explicit regenerate (`AgentChat.sendRaw([], { trigger: "regenerate-message" })`). Register `onRecoveryBoot` to control what a continuation does with in-flight messages; see the risks section.
4. **Background tasks** (Git documents, reminders, email) use `retry.outOfMemory.machine` one size up: `small-1x` to `medium-1x` for Git, `micro` to `small-1x` for the rest. Also set `maxDuration` per task and idempotency keys derived from domain ids (for example `commit:${taskId}:${revision}`) with an explicit `idempotencyKeyTTL`.
5. **Reminders** use one declarative `schedules.task` with `cron: { pattern: "0,30,45 * * * *", timezone: "UTC", environments: ["PRODUCTION", "STAGING"] }`, `ttl: "10m"` and `queue: { concurrencyLimit: 1 }`. Do the per-user timezone math in the task. Do not create per-user imperative schedules: Hobby allows 100 per project, and dedup keys are project-wide. Stay on a paid plan; a free-plan org rejects this cron.
6. **Local dev scheduling:** omit `DEVELOPMENT` from `environments` and test the sweep through the dashboard's "Test schedule" button or `tasks.trigger`. Otherwise a running dev CLI fires the sweep 72 times a day.
7. **Deploys run from GitHub Actions on every push to `main`** with `pnpm --filter @symplist/worker exec trigger deploy --env prod --external-id ${{ github.sha }}`.
   - Prefer a prod "Deploy only" environment API key over a Personal Access Token for `TRIGGER_ACCESS_TOKEN`: it is narrower and scoped to one environment.
   - Do not add a `paths:` filter if skew protection is enabled.
   - Adopting skew protection (`TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION=1` on Render, which reads `RENDER_GIT_COMMIT`) is a reasonable default for chat pinning. It needs an explicit owner decision, because a failed Trigger deploy then expires runs from that Render release after 1 hour.
8. **Env vars:** use `syncEnvVars` with an explicit allowlist read from GitHub secrets, and `isSecret: true` for keys. Remember that it never deletes stale variables, and that re-running the same `--external-id` after a secret change needs `--force`. Local dev keeps using `apps/worker/.env`, which is git-ignored.
9. **Workspace code in tasks:**
   - Share TypeScript-source workspace packages freely; they get bundled.
   - Keep `argon2` in Nest only, since it is an auth concern. If a task ever needs a native package, add it to `build.external` explicitly.
   - After adding native dependencies, check the generated build `package.json`. `trigger deploy --dry-run` prints the build path.
10. **Tests:**
    - Keep business logic in plain modules and test it directly.
    - Use `mockChatAgent` for Simon's hooks and turn behavior.
    - For wrapper-level task tests, use `resourceCatalog.getTask(id).fns.run` inside `runInMockTaskContext`, not `task.fns`.
    - Exclude tests from bundles; the CLI already skips `.test` and `.spec` files.

## Risks and open questions

**Privacy and encryption.**
- The default transcript storage writes the full conversation to Trigger's object store.
- `session.out` holds up to about one turn of plaintext chunks.
- The first message rides in the session's `basePayload` when `trigger: "submit-message"` is used.
- Symplist's "encrypted content" posture needs a decision: (a) a custom `TranscriptStorage` that encrypts into D1, plus accepting transient plaintext in S2 and in run traces and logs, or (b) sending opaque references instead of content. Also check whether LLM spans from `@ai-sdk/otel` record prompt text; AI telemetry must never record content. Set `TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0` if they do.

**Recovery boot versus "never re-run automatically".**
- On a continuation after a crash or cancel, messages that were in flight on `.in` "dispatch as fresh turns" unless they are spliced as context with a partial response.
- A user message whose run died before streaming could therefore be answered again, including tool calls, when the next message arrives.
- Mitigations: an `onRecoveryBoot` policy, plus idempotent tool side effects (email, integrations) keyed by the tool call id.
- https://trigger.dev/docs/ai-chat/patterns/recovery-boot

**Documentation and type inconsistencies (4.6.0).**
- `AgentChat.triggerConfig` requires `basePayload` in types, while the docs say it is `Partial`.
- `myTask.fns.run` in the testing docs does not exist.
- The channels page says appending to a closed session returns `400`; the sessions and protocol pages say `409` (`session_closed`). Handle both.
- The runs page says an idempotent re-trigger of a finished run "returns the previous output or error", while the idempotency page says failed runs clear the key.
- The docs still call AI SDK v7 canary.

**Limits on Hobby** (https://trigger.dev/docs/limits).
- 25 concurrent runs. Only actively executing runs count, so suspended chat runs do not, but chats inside their 30s warm idle window do.
- 50 concurrent realtime connections.
- **Open question:** do Nest's session `.out` SSE reads and `runs.subscribeToRun` count toward the 50-connection realtime limit? If they do, concurrent streaming chats cap closed-beta capacity. Measure this, or ask Trigger.dev.

**`maxDuration` for chat.**
- It is CPU time per attempt, and the agent's warm idle wait (`waitWithIdleTimeout`) is not listed among the excluded waits.
- Verify that a long conversation on one run does not hit the 900s config default. Set a larger `maxDuration` on `simon-chat` if needed.
- `maxTurns` defaults to 100 per run.

**`AgentChat` append idempotency.** Each append uses a fresh random `X-Part-Id`, so a Nest-level retry of `sendMessage` can duplicate a user message. Dedupe on Symplist's own message id before calling.

**Native externals depend on the build host** unless listed explicitly. This was verified by experiment: without an explicit entry, the darwin-arm64 binary was externalized.

**Declarative schedule coverage.** `0,30,45` reaches the local top of the hour for :30 and :45 offsets. Pacific/Chatham (UTC+12:45, and +13:45 in DST) lands at :15 UTC and would be served at :30, 15 minutes late. That is acceptable under the 24h lateness rule, but worth recording.

**`syncEnvVars` and `--external-id`.** A secret rotation needs a redeploy with `--force`, or a dashboard edit. Removed variables linger in Trigger until deleted by hand.

**Deploy key presets.** The docs say "Some presets require a paid plan" without naming them. Confirm that "Deploy only" is available on Hobby; otherwise fall back to a Personal Access Token.

**Dev secret key.** Still pending (per `progress.md`). No live dev trigger or chat round trip was run in this research. The first live check should cover `AgentChat` send, stream, stop and reconnect against the dev environment, plus one scheduled sweep in staging.
