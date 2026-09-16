import { type DbClient, int, type Statement, sql } from "@symplist/db";

export interface MaintenanceGuard {
  readonly sql: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Trusted executor/lease predicate, evaluated inside every deciding cleanup statement. */
export function maintenanceStatement(
  query: string,
  params: Readonly<Record<string, string>>,
  guard?: MaintenanceGuard,
): Statement {
  return sql(guard ? `${query} AND (${guard.sql})` : query, {
    ...params,
    ...guard?.params,
  });
}

export class MaintenanceFence {
  constructor(
    private readonly db: DbClient,
    readonly execution: {
      readonly executor: "local" | "trigger";
      readonly generation: number;
      readonly signal?: AbortSignal;
    },
  ) {}
  guard(): MaintenanceGuard {
    return {
      sql: `:maintenance_active='1' AND EXISTS (SELECT 1 FROM executor_state WHERE id=1 AND mode=:maintenance_mode AND generation=CAST(:maintenance_generation AS INTEGER))`,
      params: {
        maintenance_active: this.execution.signal?.aborted ? "0" : "1",
        maintenance_mode: this.execution.executor === "trigger" ? "durable" : "local",
        maintenance_generation: int(this.execution.generation),
      },
    };
  }
  async current(): Promise<boolean> {
    if (this.execution.signal?.aborted) return false;
    const guard = this.guard();
    const row = await this.db.first(sql(`SELECT 1 WHERE ${guard.sql}`, guard.params));
    return !!row && !this.execution.signal?.aborted;
  }
}
