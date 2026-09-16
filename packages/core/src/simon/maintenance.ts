import { int, sql } from "@symplist/db";
import type { ExecutorKind } from "../events/execution.ts";
import { SimonApprovals } from "./approvals.ts";
import { pauseGuard } from "./continuations.ts";
import type { SimonRepository } from "./repository.ts";
import { SimonUserAsks } from "./user-asks.ts";

/** A bounded sweep shared by the local and durable schedulers; every expiry owns its continuation. */
export class SimonPauseReconciler {
  constructor(readonly repository: SimonRepository) {}

  async run(input: {
    executor: ExecutorKind;
    generation: number;
  }): Promise<{ consideredCount: number }> {
    const now = this.repository.options.now();
    const guard = {
      sql: "EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode = :sweep_mode AND generation = :sweep_generation)",
      params: {
        sweep_mode: input.executor === "trigger" ? "durable" : "local",
        sweep_generation: int(input.generation),
      },
    };
    const rows = await this.repository.options.db.all(
      sql(
        `SELECT id, owner_id, run_id, kind FROM (
      SELECT id, owner_id, run_id, expires_at, 'approval' AS kind FROM approvals WHERE status = 'pending' AND expires_at <= :now
        AND ${pauseGuard(this.repository, "approvals")}
        AND ${this.repository.access("sweep_owner").replaceAll(":sweep_owner", "approvals.owner_id")}
      UNION ALL SELECT id, owner_id, run_id, expires_at, 'ask' AS kind FROM user_asks WHERE status = 'pending' AND expires_at <= :now
        AND ${pauseGuard(this.repository, "user_asks")}
        AND ${this.repository.access("sweep_owner").replaceAll(":sweep_owner", "user_asks.owner_id")}
      ) WHERE ${guard.sql} ORDER BY expires_at, id LIMIT 25`,
        { now: int(now), ...guard.params },
      ),
    );
    if (!rows.length) return { consideredCount: 0 };
    const approvals = new SimonApprovals(this.repository);
    const asks = new SimonUserAsks(this.repository);
    await this.repository.options.db.batch(
      rows.flatMap((row) => {
        const common = { ownerId: String(row.owner_id), runId: String(row.run_id), now, guard };
        return row.kind === "approval"
          ? approvals.expireStatements({ ...common, approvalId: String(row.id), cause: "time" })
          : asks.expireStatements({ ...common, askId: String(row.id) });
      }),
    );
    return { consideredCount: rows.length };
  }
}
