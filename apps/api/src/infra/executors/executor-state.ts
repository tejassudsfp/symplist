import type { ExecutorMode } from "@symplist/core/events";
import { type DbClient, type DbRow, int, newWriteId, sql, verifiedRow } from "@symplist/db";
import type { OperationalLog, RuntimeTimers } from "../scheduler/runtime.ts";

/** The single `executor_state` row (§8.1). */
export interface ExecutorStateRecord {
  /** NULL until the first api start records the configured mode. */
  readonly mode: ExecutorMode | null;
  readonly generation: number;
  readonly switchedAt: number | null;
  readonly updatedAt: number;
  readonly writeId: string;
}

const columns = "mode, generation, switched_at, updated_at, write_id";

function toRecord(row: DbRow): ExecutorStateRecord {
  const mode = row.mode;
  if (mode !== null && mode !== "local" && mode !== "durable") {
    throw new Error("executor_state.mode holds an unknown value");
  }
  return Object.freeze({
    mode,
    generation: Number(row.generation),
    switchedAt: row.switched_at === null ? null : Number(row.switched_at),
    updatedAt: Number(row.updated_at),
    writeId: String(row.write_id),
  });
}

/** Reads and conditionally writes `executor_state` (§8.1, §3.2). */
export class ExecutorStateRepository {
  constructor(private readonly db: DbClient) {}

  async read(): Promise<ExecutorStateRecord> {
    const row = await this.db.first(sql(`SELECT ${columns} FROM executor_state WHERE id = 1`));
    if (!row) throw new Error("executor_state is missing its row; run the foundation migrations");
    return toRecord(row);
  }

  /** Records the configured mode on the first api start; null when a mode was already recorded. */
  async recordInitialMode(mode: ExecutorMode, now: number): Promise<ExecutorStateRecord | null> {
    const writeId = newWriteId();
    const results = await this.db.batch([
      sql(
        `UPDATE executor_state SET mode = :mode, updated_at = :now, write_id = :w
         WHERE id = 1 AND mode IS NULL`,
        { mode, now: int(now), w: writeId },
      ),
      sql(`SELECT ${columns} FROM executor_state WHERE id = 1 AND write_id = :w`, { w: writeId }),
    ]);
    const row = verifiedRow(results);
    return row ? toRecord(row) : null;
  }

  /**
   * Advances the generation and sets the mode, conditional on the generation the caller read, so two
   * concurrent switches cannot both take effect. Null when the generation had already moved.
   */
  async advance(input: {
    readonly expectedGeneration: number;
    readonly mode: ExecutorMode;
    readonly now: number;
  }): Promise<ExecutorStateRecord | null> {
    const writeId = newWriteId();
    const results = await this.db.batch([
      sql(
        `UPDATE executor_state
         SET mode = :mode, generation = generation + 1, switched_at = :now, updated_at = :now, write_id = :w
         WHERE id = 1 AND generation = :expected`,
        {
          mode: input.mode,
          now: int(input.now),
          w: writeId,
          expected: int(input.expectedGeneration),
        },
      ),
      sql(`SELECT ${columns} FROM executor_state WHERE id = 1 AND write_id = :w`, { w: writeId }),
    ]);
    const row = verifiedRow(results);
    return row ? toRecord(row) : null;
  }
}

/** Why this api may or may not execute durable work right now. */
export type ExecutorReadiness =
  | { readonly usable: true; readonly generation: number; readonly mode: ExecutorMode }
  | {
      readonly usable: false;
      readonly reason: "mode_mismatch" | "unrecorded";
      readonly generation: number;
    };

/** What the relay, the scheduler and the dispatcher read about the executor generation. */
export interface ExecutorStateReader {
  readonly configuredMode: ExecutorMode;
  /** Reads D1 now (dispatch, scans and reconciliation always read fresh, §3.3). */
  readFresh(): Promise<ExecutorStateRecord>;
  /** A cached read no older than `maxAgeMs` (default 10 seconds), for the run output relay (§6.2). */
  readCached(maxAgeMs?: number): Promise<ExecutorStateRecord>;
  /** Whether a state lets this api execute in its configured mode. */
  readiness(state: ExecutorStateRecord): ExecutorReadiness;
  /** Records the configured mode when none is recorded yet, then reports readiness. */
  initialize(): Promise<ExecutorReadiness>;
}

/**
 * The executor generation as seen by this process: records the configured mode on first start and
 * refuses to execute anything while `executor_state.mode` differs from `DURABLE` until the operator
 * runs `executor:switch` (§8.1).
 */
export class ExecutorStateService implements ExecutorStateReader {
  private cached: { readonly record: ExecutorStateRecord; readonly readAt: number } | undefined;
  private inflight: Promise<ExecutorStateRecord> | undefined;

  constructor(
    private readonly repository: ExecutorStateRepository,
    readonly configuredMode: ExecutorMode,
    private readonly timers: RuntimeTimers,
    private readonly log: OperationalLog,
  ) {}

  readFresh(): Promise<ExecutorStateRecord> {
    this.inflight ??= this.repository
      .read()
      .then((record) => {
        this.cached = { record, readAt: this.timers.now() };
        return record;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  async readCached(maxAgeMs = 10_000): Promise<ExecutorStateRecord> {
    const cached = this.cached;
    if (cached && this.timers.now() - cached.readAt < maxAgeMs) return cached.record;
    return this.readFresh();
  }

  readiness(state: ExecutorStateRecord): ExecutorReadiness {
    if (state.mode === null) {
      return { usable: false, reason: "unrecorded", generation: state.generation };
    }
    if (state.mode !== this.configuredMode) {
      return { usable: false, reason: "mode_mismatch", generation: state.generation };
    }
    return { usable: true, generation: state.generation, mode: state.mode };
  }

  /** Called at api startup: records the configured mode when none is recorded and reports a mismatch. */
  async initialize(): Promise<ExecutorReadiness> {
    let state = await this.readFresh();
    if (state.mode === null) {
      const recorded = await this.repository.recordInitialMode(
        this.configuredMode,
        this.timers.now(),
      );
      state = recorded ?? (await this.readFresh());
      if (recorded) this.cached = { record: recorded, readAt: this.timers.now() };
    }
    const readiness = this.readiness(state);
    if (readiness.usable) {
      this.log.info("executor.state_ready", {
        mode: readiness.mode,
        generation: readiness.generation,
      });
    } else {
      this.log.error("executor.mode_mismatch", {
        configuredMode: this.configuredMode,
        recordedMode: state.mode,
        generation: state.generation,
      });
    }
    return readiness;
  }
}
