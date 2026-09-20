import type { DbClient } from "@symplist/db";
import { int, sql } from "@symplist/db";
import type { ConnectionToolAuthority, ExternalToolSchema } from "@symplist/integrations";
import { IntegrationError } from "@symplist/integrations";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import type { SimonRepository } from "../simon/repository.ts";
import type { ClaimedSimonRun } from "../simon/types.ts";

export interface ConfirmedConnection {
  readonly id: string;
  readonly ownerId: string;
  readonly toolkit: string;
  readonly connectedAccountId: string;
  readonly generation: number;
}

type SchemaReader = (slug: string) => Promise<ExternalToolSchema>;

function rowsToConnections(rows: readonly Record<string, unknown>[]): ConfirmedConnection[] {
  if (rows.length > 500) throw new IntegrationError("integration.unavailable");
  return rows.map((row) => ({
    id: String(row.id),
    ownerId: String(row.owner_id),
    toolkit: String(row.toolkit),
    connectedAccountId: String(row.connected_account_id),
    generation: Number(row.generation),
  }));
}

/** Fresh run-scoped authority shared by the local and durable Simon adapters. */
export function createSimonConnectionAuthority(
  repository: SimonRepository,
  claim: ClaimedSimonRun,
  schema: SchemaReader,
): ConnectionToolAuthority {
  const { run } = claim;
  const connections = async () =>
    rowsToConnections(
      await repository.options.db.all(
        sql(
          `SELECT c.id,c.owner_id,c.toolkit,c.connected_account_id,c.generation FROM connections c
          WHERE c.owner_id=:connection_owner AND c.status='active'
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)
          AND EXISTS (SELECT 1 FROM runs WHERE id=:connection_run AND owner_id=:connection_owner
            AND executor_generation=:connection_generation AND ${repository.runGuard()})
          ORDER BY c.toolkit,c.id LIMIT 501`,
          {
            connection_owner: run.ownerId,
            connection_run: run.id,
            connection_generation: int(run.generation),
            now: int(repository.options.now()),
          },
        ),
      ),
    );
  return {
    ownerId: run.ownerId,
    check: () => repository.mayExecute(run),
    connections,
    schema,
  };
}

/** Metadata-only owner authority for trusted-UI approval edits in the durable API. */
export function createOwnerConnectionAuthority(options: {
  readonly db: DbClient;
  readonly ownerId: string;
  readonly policy: AccessPolicy;
  readonly schema: SchemaReader;
}): ConnectionToolAuthority {
  const access = accessCondition({
    level: "admitted",
    policy: options.policy,
    userParam: "connection_owner",
  });
  const check = async () =>
    Boolean(
      await options.db.first(
        sql(
          `SELECT id FROM users WHERE id=:connection_owner AND ${access}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)`,
          { connection_owner: options.ownerId },
        ),
      ),
    );
  return {
    ownerId: options.ownerId,
    check,
    schema: options.schema,
    connections: async () => {
      const rows = await options.db.all(
        sql(
          `SELECT c.id,c.owner_id,c.toolkit,c.connected_account_id,c.generation FROM connections c
          WHERE c.owner_id=:connection_owner AND c.status='active' AND ${access}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)
          ORDER BY c.toolkit,c.id LIMIT 501`,
          { connection_owner: options.ownerId },
        ),
      );
      return rowsToConnections(rows);
    },
  };
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
