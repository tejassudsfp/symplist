import type { BatchOptions, DbClient, DbRow, Statement, StatementResult } from "@symplist/db";

/**
 * Coalesces the scanner's bounded concurrent claim/validation/checkpoint wave into D1 batches.
 * Logical writes stay contiguous and unsplit, and each caller receives only its own verification rows.
 * This is scoped to one scan, never a process-wide queue that could mix unrelated authorization.
 */
export class ScannerBatchDb implements DbClient {
  private pending: Array<{
    statements: readonly Statement[];
    resolve: (results: readonly StatementResult[]) => void;
    reject: (error: unknown) => void;
  }> = [];
  private queued = false;
  constructor(
    readonly db: DbClient,
    readonly signal?: AbortSignal,
  ) {}
  batch(
    statements: readonly Statement[],
    options?: BatchOptions,
  ): Promise<readonly StatementResult[]> {
    if (options) return this.db.batch(statements, options);
    return new Promise((resolve, reject) => {
      this.pending.push({ statements, resolve, reject });
      if (!this.queued) {
        this.queued = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    });
  }
  async all<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<readonly Row[]> {
    return ((await this.batch([statement], options))[0]?.results ?? []) as readonly Row[];
  }
  async first<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<Row | null> {
    return (await this.all<Row>(statement, options))[0] ?? null;
  }
  async run(statement: Statement, options?: BatchOptions): Promise<StatementResult> {
    const result = (await this.batch([statement], options))[0];
    if (!result) throw new Error("scheduling.batch_invalid");
    return result;
  }
  private async flush() {
    const pending = this.pending;
    this.pending = [];
    this.queued = false;
    // At most 50 occurrences * a bounded write plan. Split only between callers if SQL plans grow.
    let offset = 0;
    while (offset < pending.length) {
      const group = pending.slice(offset, offset + 25);
      offset += group.length;
      try {
        const results = await this.db.batch(
          group.flatMap((entry) => [...entry.statements]),
          this.signal ? { signal: this.signal } : undefined,
        );
        let index = 0;
        for (const entry of group) {
          entry.resolve(results.slice(index, index + entry.statements.length));
          index += entry.statements.length;
        }
      } catch (error) {
        for (const entry of group) entry.reject(error);
      }
    }
  }
}
