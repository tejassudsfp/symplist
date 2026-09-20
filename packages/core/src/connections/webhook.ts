import { int, sql, uuidv7 } from "@symplist/db";
import type { VerifiedConnectionWebhook } from "@symplist/integrations";
import type { SimonRepository } from "../simon/repository.ts";
import { connectionApprovalExpiryStatements } from "./approval-expiry.ts";
import type { ComposioSessions } from "./sessions.ts";

export class ConnectionWebhooks {
  constructor(
    private readonly repository: SimonRepository,
    private readonly sessions: Pick<ComposioSessions, "use">,
    private readonly changed?: (ownerId: string, connectionId: string) => Promise<void>,
  ) {}

  async apply(event: VerifiedConnectionWebhook): Promise<{ status: "accepted" | "duplicate" }> {
    const { db, now } = this.repository.options;
    const connection = event.accountId
      ? await db.first(
          sql(
            `SELECT id, owner_id, generation FROM connections WHERE connected_account_id = :account AND status = 'active'`,
            { account: event.accountId },
          ),
        )
      : null;
    const write = uuidv7(now());
    const receipt = `EXISTS (SELECT 1 FROM webhook_receipts WHERE provider = 'composio' AND receipt_id = :receipt AND write_id = :write)`;
    const result = await db.batch([
      sql(
        `INSERT INTO webhook_receipts (provider, receipt_id, event_type, received_at, write_id) VALUES ('composio', :receipt, :event, :now, :write) ON CONFLICT (provider, receipt_id) DO NOTHING`,
        {
          receipt: event.receiptId,
          event: event.event === "expired" ? "composio.connected_account.expired" : "ignored",
          now: int(now()),
          write,
        },
      ),
      ...(connection && event.accountId
        ? [
            sql(
              `UPDATE connections SET status = 'needs_attention', generation = generation + 1, updated_at = :now, write_id = :write
        WHERE id = :id AND owner_id = :owner AND connected_account_id = :account AND generation = :generation AND status = 'active' AND ${receipt}`,
              {
                now: int(now()),
                write,
                id: String(connection.id),
                owner: String(connection.owner_id),
                account: event.accountId,
                generation: int(Number(connection.generation)),
                receipt: event.receiptId,
              },
            ),
            ...connectionApprovalExpiryStatements(this.repository, {
              ownerId: String(connection.owner_id),
              connectionId: String(connection.id),
              writeId: write,
              now: now(),
            }),
          ]
        : []),
      sql(
        `SELECT 1 FROM webhook_receipts WHERE provider = 'composio' AND receipt_id = :receipt AND write_id = :write`,
        { receipt: event.receiptId, write },
      ),
      sql(`SELECT id, owner_id FROM connections WHERE id = :id AND write_id = :write`, {
        id: connection ? String(connection.id) : "",
        write,
      }),
    ]);
    if (!result.at(-2)?.results[0]) return { status: "duplicate" };
    const updated = result.at(-1)?.results[0];
    if (updated) {
      // Publication is generation-fenced by ComposioSessions. Native authority is already revoked
      // if pins cannot be refreshed now; the next use/reconciliation tries again.
      await this.sessions.use(String(updated.owner_id)).catch(() => undefined);
      await this.changed?.(String(updated.owner_id), String(updated.id));
    }
    return { status: "accepted" };
  }
}
