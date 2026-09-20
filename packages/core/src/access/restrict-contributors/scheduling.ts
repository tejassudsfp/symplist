import { sql } from "@symplist/db";
import { restrictGuard } from "../sql.ts";
import type { RestrictContributor } from "./types.ts";

/** Scheduling restriction statements (§5.5). Mark pending reminder occurrences `suppressed_access`, cancel pending outbox rows and increment reminder generations. */
export const schedulingRestrictContributor: RestrictContributor = {
  domain: "scheduling",
  statements: (input) => {
    const guard = restrictGuard(input);
    const params = { scheduling_owner: input.userId, scheduling_w: input.writeId, ...guard.params };
    const where = `owner_id=:scheduling_owner AND ${guard.exists}`;
    return [
      sql(
        `UPDATE reminders SET generation=generation+1,status='cancelled',write_id=:scheduling_w WHERE status='active' AND ${where}`,
        params,
      ),
      sql(
        `UPDATE reminder_occurrences SET status='suppressed_access',write_id=:scheduling_w WHERE status IN ('pending','claimed') AND ${where}`,
        params,
      ),
      sql(
        `UPDATE notification_outbox SET status='cancelled',write_id=:scheduling_w WHERE status IN ('pending','claimed','uncertain') AND ${where}`,
        params,
      ),
    ];
  },
};
