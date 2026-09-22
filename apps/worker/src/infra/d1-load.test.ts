import { setTimeout as delay } from "node:timers/promises";
import { runSimonTurn } from "@symplist/agent";
import {
  DocumentRepository,
  DocumentTools,
  DurableDocumentGit,
  runDocumentGitJob,
} from "@symplist/core/documents";
import { collectExecutionKinds } from "@symplist/core/events";
import { IdempotencyStore } from "@symplist/core/idempotency";
import { ReminderScanner, SchedulingService } from "@symplist/core/scheduling";
import { SimonError, SimonRepository, type SimonWriteFold } from "@symplist/core/simon";
import { createKeyProvider } from "@symplist/crypto";
import {
  createApiLane,
  createD1RestClient,
  createWorkerLane,
  D1_BUDGET,
  D1CircuitBreaker,
  type DbClient,
  type RateLane,
  sql,
} from "@symplist/db";
import { createScriptedModel, FakeClock, scriptedText, scriptedToolCall } from "@symplist/testing";
import { describe, expect, it, vi } from "vitest";
import { createDocumentsTestEnvironment } from "../../../../packages/core/src/documents/test-support.ts";
import {
  FAKE_D1_ACCOUNT_ID,
  FAKE_D1_API_TOKEN,
  FAKE_D1_DATABASE_ID,
  FakeD1Api,
} from "../../../../packages/testing/src/contracts/db/fake-d1-api.ts";
import { DispatchIntentRepository } from "../../../api/src/infra/executors/dispatch-intents.ts";
import { ExecutionDispatcher } from "../../../api/src/infra/executors/dispatcher.ts";
import { ExecutionRegistry } from "../../../api/src/infra/executors/execution-registry.ts";
import {
  ExecutorStateRepository,
  ExecutorStateService,
} from "../../../api/src/infra/executors/executor-state.ts";
import { TriggerExecutor } from "../../../api/src/infra/executors/trigger-executor.ts";
import { d1, d1Git, d1QueueFamilyConcurrency, reminderScan } from "../queues.ts";

/** A bounded fake of a Trigger queue, retaining one D1 bucket per process across task deliveries. */
class Queue<T> {
  private readonly waiting: ((slot: T) => void)[] = [];
  active = 0;
  peak = 0;
  constructor(private readonly slots: T[]) {}
  async run<R>(work: (slot: T) => Promise<R>): Promise<R> {
    const slot =
      this.slots.pop() ?? (await new Promise<T>((resolve) => this.waiting.push(resolve)));
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await work(slot);
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next(slot);
      else this.slots.push(slot);
    }
  }
}

/** Advance only the injected clock; real Git subprocesses and streams still get event-loop time. */
async function drive<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  const observed = work.finally(() => {
    done = true;
  });
  // Attach rejection immediately, even while driving time, so a failed turn is never unhandled.
  void observed.catch(() => {});
  for (let tick = 0; !done && tick < 1800; tick++) {
    await delay(2);
    await clock.advance(1000);
  }
  expect(done, "load must finish within 30 minutes of simulated queue time").toBe(true);
  return observed;
}

describe("combined D1 request budget (§3.1)", () => {
  it("counts ten five-step durable turns, their Git children and fifty due reminders through REST", async () => {
    const env = await createDocumentsTestEnvironment();
    const foldKeys = createKeyProvider({
      IDEMPOTENCY_SECRET: { current: 1, versions: new Map([[1, Buffer.alloc(32, 7)]]) },
    });
    try {
      const owner = await env.createUser();
      const schedules = new SchedulingService({
        db: env.db,
        keys: env.keys,
        policy: { betaAccessRequired: true },
        now: () => env.clock,
      });
      const tasks: { taskId: string; revision: string; sectionId: string }[] = [];
      for (let index = 0; index < 50; index++) {
        const taskId = await env.createTask(owner);
        await schedules.save({
          ownerId: owner,
          taskId,
          actor: "user",
          requestId: `seed-${index}`,
          data: {
            baseVersion: 0,
            deadline: null,
            reminders: [
              {
                rule: {
                  kind: "absolute",
                  local: "2026-09-15T10:00",
                  zone: "UTC",
                  disambiguation: "reject",
                },
                channels: ["in_app"],
                overrideQuiet: false,
              },
            ],
          },
        });
        if (index < 10) {
          const published = await env.tools.updateSection(env.simon(owner, taskId), {
            taskId,
            expectedRevision: null,
            placement: "end",
            markdown: `## Section\nOriginal ${index}`,
          });
          const outline = await env.tools.outline(env.simon(owner, taskId), { taskId });
          const sectionId = outline.entries[0]?.sectionId;
          if (!sectionId || !published.revision) throw new Error("seed document has no section");
          tasks.push({
            taskId,
            revision: published.revision,
            sectionId,
          });
        }
      }
      await env.db.run(sql("UPDATE executor_state SET mode='durable' WHERE id=1"));
      const clock = new FakeClock(Date.parse("2026-09-15T10:00Z"));
      const start = clock.now();
      const fake = new FakeD1Api({ database: env.db });
      const requests: { process: string; at: number }[] = [];
      function client(process: string, lane: RateLane) {
        return createD1RestClient({
          accountId: FAKE_D1_ACCOUNT_ID,
          databaseId: FAKE_D1_DATABASE_ID,
          apiToken: FAKE_D1_API_TOKEN,
          runtime: process === "api" ? "api" : "worker",
          lane,
          clock,
          circuit: new D1CircuitBreaker({ clock }),
          fetch: (url, init) => {
            requests.push({ process, at: clock.now() - start });
            return fake.fetch(url, init);
          },
        });
      }
      const api = client("api", createApiLane({ clock }));
      const store = new IdempotencyStore({ db: api, keys: foldKeys });
      function fold(scope: string, key: string, input: unknown): SimonWriteFold {
        const request = { scope, userId: owner, key, input, now: clock.now() };
        const folded = store.foldedClaim(request);
        return {
          ...folded,
          completion: (response, accountKey) =>
            store.completeStatement({
              claim: folded.claim,
              response,
              accountKey,
              now: clock.now(),
            }),
          decide: (results, accountKey, offset) => {
            const decision = store.decideFoldedClaim({
              request,
              folded,
              results,
              accountKey,
              offset,
            });
            if (decision.kind === "mismatch") throw new SimonError("idempotency.mismatch");
            if (decision.kind === "in_progress") throw new SimonError("idempotency.in_progress");
            return decision.kind === "replay"
              ? { kind: "replay", body: decision.response.body }
              : decision;
          },
        };
      }
      expect(reminderScan.concurrencyLimit).toBe(1);
      expect(d1QueueFamilyConcurrency).toBe(D1_BUDGET.worker.familyConcurrency);
      const worker = (name: string) =>
        client(name, createWorkerLane({ clock, familyConcurrency: d1QueueFamilyConcurrency }));
      const turns = new Queue(
        Array.from({ length: d1.concurrencyLimit ?? 0 }, (_, i) => worker(`turn-${i}`)),
      );
      const children = new Queue(
        Array.from({ length: d1Git.concurrencyLimit ?? 0 }, (_, i) => worker(`git-${i}`)),
      );
      const scanDb = worker("scan");
      const simon = (db: DbClient) =>
        new SimonRepository({
          db,
          keys: env.keys,
          now: clock.nowFn,
          policy: { betaAccessRequired: true },
          quickChatTtlHours: 24,
        });
      const documents = (db: DbClient) => {
        const repository = new DocumentRepository({
          db,
          objects: env.objects,
          keys: env.keys,
          git: env.git,
          accessPolicy: { betaAccessRequired: true },
          docMaxBytes: 1_048_576,
          now: clock.nowFn,
        });
        return { repository, tools: new DocumentTools(repository) };
      };
      let childCount = 0;
      const notify = vi.fn(async () => {});
      const send = vi.fn(async () => ({ providerId: "unused" }));
      const scanner = new ReminderScanner({
        ...schedules.options,
        db: scanDb,
        now: clock.nowFn,
        email: { send },
        renderEmail: async () => {
          throw new Error("in-app fixture must not render email");
        },
        notify,
      });
      const scripts = tasks.map(({ taskId, sectionId, revision }, index) =>
        createScriptedModel([
          scriptedToolCall("task_document_read_section", { taskId, sectionId, revision }),
          scriptedToolCall("task_document_update_section", {
            taskId,
            sectionId,
            expectedRevision: revision,
            placement: "replace",
            markdown: `## Section\nUpdated ${index}`,
          }),
          scriptedToolCall("rules_read", {}),
          scriptedToolCall("rules_read", {}),
          scriptedText("Updated the section."),
        ]),
      );
      // All ten requests arrive together. Trigger admits four parents and two children, never ten
      // independent worker buckets. Seeding and post-run assertions are deliberately outside REST.
      const runIndexes = new Map<string, number>();
      const executions = new Map<string, ReturnType<typeof runSimonTurn>>();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const dispatcher = new ExecutionDispatcher({
        repository: new DispatchIntentRepository(api),
        registry: new ExecutionRegistry(collectExecutionKinds(), api),
        state: new ExecutorStateService(new ExecutorStateRepository(api), "durable", clock, log),
        timers: clock,
        log,
        executor: new TriggerExecutor({
          runs: { cancel: vi.fn(), retrieve: vi.fn() },
          // The load shape is the task dispatch; sessions stay off, so a call here is a defect.
          sessions: {
            start: async () => {
              throw new Error("sessions are not enabled for this dispatch");
            },
          },
          tasks: {
            trigger: async (id, payload, options) => {
              expect(id).toBe("simon-run");
              const runId = (payload as { runId: string }).runId;
              expect(payload).toEqual({ runId });
              expect(options?.idempotencyKey).toBe(runId);
              const index = runIndexes.get(runId);
              if (index === undefined) throw new Error("dispatcher selected an unexpected run");
              const execution = turns.run(async (db) => {
                const docs = documents(db);
                const git = new DurableDocumentGit({
                  artifacts: docs.repository.artifacts,
                  now: clock.nowFn,
                  triggerAndWait: async (id, payload) => {
                    expect(id).toBe("document-git");
                    return children.run(async (childDb) => {
                      childCount++;
                      const childDocs = documents(childDb);
                      return {
                        ok: true,
                        id: `child-${childCount}`,
                        output: await runDocumentGitJob({
                          payload,
                          db: childDb,
                          accountKeys: childDocs.repository.accountKeys,
                          artifacts: childDocs.repository.artifacts,
                          tools: childDocs.tools,
                          now: clock.nowFn,
                        }),
                      };
                    });
                  },
                });
                const script = scripts[index];
                if (!script) throw new Error("missing script");
                return runSimonTurn(runId, {
                  repository: simon(db),
                  executor: "trigger",
                  models: {
                    resolve: () => ({ provider: "scripted", modelId: "load", model: script.model }),
                  },
                  signal: new AbortController().signal,
                  telemetryEnabled: true,
                  log: vi.fn(),
                  documents: () => ({ tools: docs.tools, git }),
                  sink: () => ({ write: () => {}, flush: async () => {}, close: async () => {} }),
                });
              });
              void execution.catch(() => {});
              executions.set(runId, execution);
              return { id: `trigger_${runId}` };
            },
          },
        }),
      });
      const execute = async () => {
        await Promise.all(
          tasks.map(async ({ taskId }, index) => {
            const conversation = await simon(api).createConversation(
              owner,
              taskId,
              fold("conversations", `create-${index}`, { kind: "task", taskId }),
            );
            const message = { text: "Read and update this section", tier: "fast" as const };
            const accepted = await simon(api).acceptMessage(
              owner,
              conversation,
              `load-${index}`,
              message,
              fold(`messages:${conversation}`, `load-${index}`, message),
            );
            expect(accepted.status).toBe("accepted");
            runIndexes.set(String(accepted.runId), index);
          }),
        );
        try {
          expect(await dispatcher.dispatchPending()).toMatchObject({
            dispatched: 10,
            failed: 0,
            skipped: 0,
          });
          const completed = await Promise.allSettled(executions.values());
          expect(completed.every((result) => result.status === "fulfilled")).toBe(true);
          return completed.map((result) =>
            result.status === "fulfilled" ? result.value : result.reason,
          );
        } finally {
          await dispatcher.close();
        }
      };
      const workload = Promise.all([
        execute(),
        scanner.run({ executor: "trigger", generation: 1 }),
      ]);
      const [results, scanned] = await drive(clock, workload);
      expect(results).toEqual(
        Array.from({ length: 10 }, () => ({ status: "completed", steps: 5 })),
      );
      expect(scripts.every((script) => script.calls.length === 5 && script.remaining() === 0)).toBe(
        true,
      );
      expect(scanned).toEqual({ occurrenceCount: 50, acceptedCount: 0 });
      expect(childCount).toBe(10);
      expect(turns.peak).toBe(d1.concurrencyLimit);
      expect(children.peak).toBeGreaterThan(0);
      expect(children.peak).toBeLessThanOrEqual(d1Git.concurrencyLimit ?? 0);
      expect(notify).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(await env.count("notifications")).toBe(50);
      expect(await env.count("read_receipts")).toBe(10);
      expect(await env.count("doc_commits")).toBe(20);
      expect(
        await env.db.first(
          sql(
            "SELECT COUNT(*) AS n FROM dispatch_intents WHERE kind='simon_run' AND status='dispatched' AND trigger_run_id IS NOT NULL",
          ),
        ),
      ).toEqual({ n: 10 });
      expect(await env.count("idempotency_records")).toBe(20);
      for (const [index, task] of tasks.entries()) {
        expect(await env.service.getHead(env.user(owner), task.taskId)).toMatchObject({
          markdown: `## Section\n\nUpdated ${index}\n`,
        });
      }
      expect(await env.db.all(sql("SELECT status,steps FROM runs"))).toEqual(
        Array.from({ length: 10 }, () => ({ status: "completed", steps: 5 })),
      );
      const runTimes = await env.db.all(sql("SELECT started_at,finished_at FROM runs"));
      const durations = runTimes.map((run) => {
        expect(run.started_at).toEqual(expect.any(Number));
        expect(run.finished_at).toEqual(expect.any(Number));
        const elapsed = Number(run.finished_at) - Number(run.started_at);
        expect(elapsed).toBeGreaterThan(0);
        expect(elapsed).toBeLessThan(900000);
        return elapsed;
      });
      expect(requests).toHaveLength(fake.requests.length);
      expect(requests.length).toBeLessThan(1000);
      // Every rolling five-minute window, not just a fixed window starting at t=0. Seven worker
      // bursts + the API burst permit at most 938 requests, while sustained rates total 3/s.
      const peakWindow = Math.max(
        ...requests.map(
          ({ at }) => requests.filter((r) => r.at >= at && r.at < at + 300000).length,
        ),
      );
      expect(peakWindow).toBeLessThan(1000);
      for (const process of new Set(requests.map((r) => r.process))) {
        const timeline = requests.filter((r) => r.process === process);
        const rate = process === "api" ? 2 : 1 / D1_BUDGET.worker.familyConcurrency;
        const burst = process === "api" ? 10 : 4;
        for (const [first, initial] of timeline.entries()) {
          for (const [last, final] of timeline.entries()) {
            if (last < first) continue;
            expect(last - first + 1).toBeLessThanOrEqual(
              burst + ((final.at - initial.at) * rate) / 1000 + 0.001,
            );
          }
        }
      }
      console.info("D1 combined load", {
        api: requests.filter((r) => r.process === "api").length,
        worker: requests.filter((r) => r.process !== "api").length,
        git: requests.filter((r) => r.process.startsWith("git-")).length,
        scan: requests.filter((r) => r.process === "scan").length,
        total: requests.length,
        peakFiveMinuteRequests: peakWindow,
        simulatedDurationMs: clock.now() - start,
        longestClaimedRunMs: Math.max(...durations),
      });
    } finally {
      foldKeys.destroy();
      await env.close();
    }
  }, 60000);
});
