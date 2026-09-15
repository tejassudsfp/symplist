import type {
  ActiveExecution,
  ExecutionOutcomeCode,
  ExecutionTracker,
  ExecutorKind,
} from "@symplist/core/events";

export interface FakeRun {
  ownerId: string;
  status: "queued" | "running" | "completed" | "stopped" | "interrupted";
  /** Null until the run's intent is dispatched and `recordDispatch` names its executor. */
  executor: ExecutorKind | null;
  generation: number;
  triggerRunId: string | null;
  heartbeatAt: number | null;
  startedAt: number | null;
  createdAt: number;
  cancelRequestedAt: number | null;
  outcomeCode: ExecutionOutcomeCode | null;
}

/** An in-memory `runs` tracker with the conditional semantics a D1 tracker must have. */
export class FakeTracker implements ExecutionTracker {
  readonly runs = new Map<string, FakeRun>();
  readonly heartbeats: { ids: readonly string[]; now: number }[] = [];
  readonly dispatches: {
    subjectId: string;
    executor: ExecutorKind;
    triggerRunId: string | null;
  }[] = [];

  add(
    subjectId: string,
    run: Partial<FakeRun> & { ownerId: string; executor: ExecutorKind | null },
  ): void {
    this.runs.set(subjectId, {
      status: "running",
      generation: 1,
      triggerRunId: null,
      heartbeatAt: null,
      startedAt: null,
      createdAt: 0,
      cancelRequestedAt: null,
      outcomeCode: null,
      ...run,
    });
  }

  async listActive(query: {
    executor: ExecutorKind;
    limit: number;
    after?: string;
    ownerId?: string;
  }): Promise<readonly ActiveExecution[]> {
    return [...this.runs.entries()]
      .filter(
        ([, run]) =>
          (run.status === "queued" || run.status === "running") && run.executor === query.executor,
      )
      .filter(([, run]) => query.ownerId === undefined || run.ownerId === query.ownerId)
      .filter(([id]) => query.after === undefined || id > query.after)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, query.limit)
      .map(([subjectId, run]) => ({
        subjectId,
        ownerId: run.ownerId,
        executor: run.executor as ExecutorKind,
        executorGeneration: run.generation,
        triggerRunId: run.triggerRunId,
        heartbeatAt: run.heartbeatAt,
        startedAt: run.startedAt,
        createdAt: run.createdAt,
        cancelRequestedAt: run.cancelRequestedAt,
      }));
  }

  async recordDispatch(
    subjectId: string,
    dispatch: { executor: ExecutorKind; triggerRunId: string | null; generation: number },
  ): Promise<void> {
    this.dispatches.push({
      subjectId,
      executor: dispatch.executor,
      triggerRunId: dispatch.triggerRunId,
    });
    const run = this.runs.get(subjectId);
    if (run) {
      run.executor = dispatch.executor;
      run.triggerRunId = dispatch.triggerRunId;
      run.generation = dispatch.generation;
    }
  }

  async recordHeartbeat(subjectIds: readonly string[], now: number): Promise<void> {
    this.heartbeats.push({ ids: [...subjectIds], now });
    for (const id of subjectIds) {
      const run = this.runs.get(id);
      if (run) run.heartbeatAt = now;
    }
  }

  async markInterrupted(
    subjectId: string,
    outcome: { outcomeCode: ExecutionOutcomeCode },
  ): Promise<boolean> {
    const run = this.runs.get(subjectId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    run.status = "interrupted";
    run.outcomeCode = outcome.outcomeCode;
    return true;
  }

  async markStopped(subjectId: string): Promise<boolean> {
    const run = this.runs.get(subjectId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    run.status = "stopped";
    return true;
  }
}
