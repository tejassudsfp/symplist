import type { DbClient } from "@symplist/db";
import { sql } from "@symplist/db";

export interface ConfirmedConnection {
  readonly id: string;
  readonly ownerId: string;
  readonly toolkit: string;
  readonly connectedAccountId: string;
  readonly generation: number;
}

/** Never infer ownership from the upstream ca_ id or model-supplied account fields. */
export async function confirmedConnection(
  db: DbClient,
  ownerId: string,
  connectionId: string,
): Promise<ConfirmedConnection | null> {
  const row = await db.first(
    sql(
      `SELECT id, owner_id, toolkit, connected_account_id, generation
    FROM connections WHERE id = :id AND owner_id = :owner AND status = 'active'`,
      { id: connectionId, owner: ownerId },
    ),
  );
  return row
    ? {
        id: String(row.id),
        ownerId: String(row.owner_id),
        toolkit: String(row.toolkit),
        connectedAccountId: String(row.connected_account_id),
        generation: Number(row.generation),
      }
    : null;
}

/** Fresh deciding-statement guard used before an approval is stored and before its effect executes. */
export function confirmedConnectionGuard(connection: ConfirmedConnection) {
  return {
    sql: `EXISTS (SELECT 1 FROM connections WHERE id = :connection_id AND owner_id = :connection_owner
      AND connected_account_id = :connection_account AND generation = :connection_generation AND status = 'active')`,
    params: {
      connection_id: connection.id,
      connection_owner: connection.ownerId,
      connection_account: connection.connectedAccountId,
      connection_generation: String(connection.generation),
    },
  };
}
