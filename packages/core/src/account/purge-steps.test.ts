import type { DbClient } from "@symplist/db";
import { describe, expect, it, vi } from "vitest";
import type { ActiveExecution, ExecutionTracker, ExecutorKind } from "../events/execution.ts";
import type { PurgeContributor } from "./purge-contributors/types.ts";
import { type KindedExecution, providerPurgeStep, stragglerRunsPurgeStep } from "./purge-steps.ts";

const USER = "01996d2a-4c00-7000-8000-00000000a001";
const OTHER = "01996d2a-4c00-7000-8000-00000000b002";
const input = { userId: USER, composioUserId: USER };

interface Subject {
  ownerId: string;
  executor: ExecutorKind;
  active: boolean;
  triggerRunId: string | null;
}

/** An in-memory tracker with the owner filter and conditional stop of the tracker contract. */
function tracker(subjects: Record<string, Subject>): ExecutionTracker & {
  readonly queries: Parameters<ExecutionTracker["listActive"]>[0][];
} {
  const queries: Parameters<ExecutionTracker["listActive"]>[0][] = [];
  return {
    queries,
    async listActive(query) {
      queries.push(query);
      return Object.entries(subjects)
        .filter(([, subject]) => subject.active && subject.executor === query.executor)
        .filter(([, subject]) => query.ownerId === undefined || subject.ownerId === query.ownerId)
        .filter(([id]) => query.after === undefined || id > query.after)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, query.limit)
        .map(
          ([subjectId, subject]): ActiveExecution => ({
            subjectId,
            ownerId: subject.ownerId,
            executor: subject.executor,
            executorGeneration: 1,
            triggerRunId: subject.triggerRunId,
            heartbeatAt: null,
            startedAt: 1,
            createdAt: 1,
            cancelRequestedAt: 2,
          }),
        );
    },
    recordDispatch: async () => undefined,
    recordHeartbeat: async () => undefined,
    markInterrupted: async () => false,
    async markStopped(subjectId) {
      const subject = subjects[subjectId];
      if (!subject?.active) return false;
      subject.active = false;
      return true;
    },
  };
}

describe("straggler runs purge step (§5.6 step 1)", () => {
  it("cancels and stops every active run of the deleted user on this runtime's executor only", async () => {
    const subjects: Record<string, Subject> = {
      r1: { ownerId: USER, executor: "trigger", active: true, triggerRunId: "run_1" },
      r2: { ownerId: USER, executor: "trigger", active: true, triggerRunId: "run_2" },
      r3: { ownerId: OTHER, executor: "trigger", active: true, triggerRunId: "run_3" },
      r4: { ownerId: USER, executor: "trigger", active: false, triggerRunId: "run_4" },
    };
    const runs = tracker(subjects);
    const cancelled: KindedExecution[] = [];
    const step = stragglerRunsPurgeStep({
      trackedKinds: [{ kind: "simon_run", tracker: runs }],
      executor: "trigger",
      cancel: async (execution) => {
        cancelled.push(execution);
      },
      now: () => 10,
      pageSize: 1,
    });
    expect(await step.run(input)).toBe("done");
    expect(cancelled.map((execution) => [execution.kind, execution.triggerRunId])).toEqual([
      ["simon_run", "run_1"],
      ["simon_run", "run_2"],
    ]);
    expect(subjects.r3?.active).toBe(true);
    expect(runs.queries.every((query) => query.ownerId === USER)).toBe(true);
    // A second invocation finds nothing left and cancels nothing.
    expect(await step.run(input)).toBe("done");
    expect(cancelled).toHaveLength(2);
  });

  it("stays incomplete while runs of the other executor remain, and never cancels them", async () => {
    const subjects: Record<string, Subject> = {
      local1: { ownerId: USER, executor: "local", active: true, triggerRunId: null },
    };
    const cancel = vi.fn(async () => undefined);
    const step = stragglerRunsPurgeStep({
      trackedKinds: [{ kind: "simon_run", tracker: tracker(subjects) }],
      executor: "trigger",
      cancel,
      now: () => 10,
    });
    expect(await step.run(input)).toBe("incomplete");
    expect(cancel).not.toHaveBeenCalled();
    subjects.local1 = { ...(subjects.local1 as Subject), active: false };
    expect(await step.run(input)).toBe("done");
  });

  it("propagates a failed cancel so the step is not recorded, and bounds its pages", async () => {
    const subjects: Record<string, Subject> = {
      a: { ownerId: USER, executor: "local", active: true, triggerRunId: null },
      b: { ownerId: USER, executor: "local", active: true, triggerRunId: null },
    };
    const failing = stragglerRunsPurgeStep({
      trackedKinds: [{ kind: "simon_run", tracker: tracker(subjects) }],
      executor: "local",
      cancel: async () => {
        throw Object.assign(new Error("unavailable"), { code: "executor.trigger_unavailable" });
      },
      now: () => 10,
    });
    await expect(failing.run(input)).rejects.toMatchObject({
      code: "executor.trigger_unavailable",
    });
    expect(subjects.a?.active).toBe(true);

    const bounded = stragglerRunsPurgeStep({
      trackedKinds: [{ kind: "simon_run", tracker: tracker(subjects) }],
      executor: "local",
      cancel: async () => undefined,
      now: () => 10,
      pageSize: 1,
      maxPages: 1,
    });
    // One page per executor kind: "a" is stopped, then the page limit leaves the step incomplete.
    expect(await bounded.run(input)).toBe("incomplete");
    expect(await bounded.run(input)).toBe("incomplete");
    expect(await bounded.run(input)).toBe("done");
    expect(() =>
      stragglerRunsPurgeStep({
        trackedKinds: [],
        executor: "local",
        cancel: async () => undefined,
        now: () => 1,
        pageSize: 0,
      }),
    ).toThrow(RangeError);
  });

  it("is done at once when no domain declares a tracked kind", async () => {
    const step = stragglerRunsPurgeStep({
      trackedKinds: [],
      executor: "local",
      cancel: async () => undefined,
      now: () => 1,
    });
    expect(await step.run(input)).toBe("done");
  });
});

describe("provider purge step (§5.6 step 2)", () => {
  const dependencies = { db: {} as DbClient, now: () => 5 };

  it("runs every contributing domain's provider purge and records done only when all are done", async () => {
    let composioLeft = 2;
    const connections: PurgeContributor = {
      domain: "connections",
      statements: () => [],
      purgeProvider: vi.fn(async (received, deps) => {
        expect(received).toEqual(input);
        expect(deps).toBe(dependencies);
        composioLeft -= 1;
        return composioLeft > 0 ? "incomplete" : "done";
      }),
    };
    const other: PurgeContributor = {
      domain: "mcp",
      statements: () => [],
      purgeProvider: vi.fn(async () => "done" as const),
    };
    const silent: PurgeContributor = { domain: "tasks", statements: () => [] };
    const step = providerPurgeStep({ dependencies, contributors: [connections, silent, other] });
    expect(await step.run(input)).toBe("incomplete");
    expect(other.purgeProvider).toHaveBeenCalledTimes(1);
    expect(await step.run(input)).toBe("done");
  });

  it("propagates provider failures", async () => {
    const step = providerPurgeStep({
      dependencies,
      contributors: [
        {
          domain: "connections",
          statements: () => [],
          purgeProvider: async () => {
            throw Object.assign(new Error("down"), { code: "integration.unavailable" });
          },
        },
      ],
    });
    await expect(step.run(input)).rejects.toMatchObject({ code: "integration.unavailable" });
  });

  it("consults registered provider state and refuses to skip a configured domain's cleanup", async () => {
    const first = vi.fn(async () => ({ has_provider_state: 1, session_id: "session_pending" }));
    const registered = { ...dependencies, db: { first } as unknown as DbClient };
    expect(await providerPurgeStep({ dependencies: registered }).run(input)).toBe("incomplete");
    expect(first).toHaveBeenCalledOnce();
  });
});
