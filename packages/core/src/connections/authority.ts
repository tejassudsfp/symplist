import type { ConnectionApprovalMode } from "@symplist/contracts";
import type { DbClient } from "@symplist/db";
import { int, sql } from "@symplist/db";
import type {
  ConnectionToolAuthority,
  ExternalConnection,
  ExternalToolSchema,
} from "@symplist/integrations";
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
  readonly approvalMode: ConnectionApprovalMode;
}

type SchemaReader = (slug: string) => Promise<ExternalToolSchema>;

/** The columns every authority read needs; the preference travels with the account it belongs to. */
const connectionColumns =
  "c.id,c.owner_id,c.toolkit,c.connected_account_id,c.generation,c.approval_mode";

/**
 * NULL is the column's pre-migration and never-chosen state, and anything unreadable is a row we do
 * not understand. Both resolve to the strict setting, so a lost or unexpected value asks.
 */
export function connectionApprovalMode(value: unknown): ConnectionApprovalMode {
  return value === "reads" ? "reads" : "all";
}

function rowsToConnections(rows: readonly Record<string, unknown>[]): ConfirmedConnection[] {
  if (rows.length > 500) throw new IntegrationError("integration.unavailable");
  return rows.map((row) => ({
    id: String(row.id),
    ownerId: String(row.owner_id),
    toolkit: String(row.toolkit),
    connectedAccountId: String(row.connected_account_id),
    generation: Number(row.generation),
    approvalMode: connectionApprovalMode(row.approval_mode),
  }));
}

function exactConnection(
  rows: readonly Record<string, unknown>[],
  expected: ExternalConnection,
): ConfirmedConnection | null {
  const current = rowsToConnections(rows)[0];
  return current &&
    current.id === expected.id &&
    current.ownerId === expected.ownerId &&
    current.toolkit === expected.toolkit &&
    current.connectedAccountId === expected.connectedAccountId &&
    current.generation === expected.generation
    ? current
    : null;
}

/** Fresh run-scoped authority shared by the local and durable Simon adapters. */
export function createSimonConnectionAuthority(
  repository: SimonRepository,
  claim: ClaimedSimonRun,
  schema: SchemaReader,
): ConnectionToolAuthority {
  const { run } = claim;
  const params = () => ({
    connection_owner: run.ownerId,
    connection_run: run.id,
    connection_generation: int(run.generation),
    now: int(repository.options.now()),
  });
  const connectionQuery = () =>
    sql(
      `SELECT ${connectionColumns} FROM connections c
          WHERE c.owner_id=:connection_owner AND c.status='active'
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)
          AND EXISTS (SELECT 1 FROM runs WHERE id=:connection_run AND owner_id=:connection_owner
            AND executor_generation=:connection_generation AND ${repository.runGuard()})
          ORDER BY c.toolkit,c.id LIMIT 501`,
      params(),
    );
  const checkQuery = () =>
    sql(
      `SELECT id FROM runs WHERE id=:connection_run AND owner_id=:connection_owner
      AND executor_generation=:connection_generation AND ${repository.runGuard()}`,
      params(),
    );
  const connections = async () =>
    rowsToConnections(await repository.options.db.all(connectionQuery()));
  return {
    ownerId: run.ownerId,
    check: () => repository.mayExecute(run),
    connections,
    snapshot: async () => {
      const [authorized, active] = await repository.options.db.batch([
        checkQuery(),
        connectionQuery(),
      ]);
      return {
        authorized: Boolean(authorized?.results.length),
        connections: rowsToConnections(active?.results ?? []),
      };
    },
    authorize: async (expected) =>
      exactConnection(
        await repository.options.db.all(
          sql(
            `SELECT ${connectionColumns}
            FROM connections c WHERE c.id=:expected_id AND c.owner_id=:connection_owner
            AND c.toolkit=:expected_toolkit AND c.connected_account_id=:expected_account
            AND c.generation=:expected_generation AND c.status='active'
            AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)
            AND EXISTS (SELECT 1 FROM runs WHERE id=:connection_run
              AND owner_id=:connection_owner AND executor_generation=:connection_generation
              AND ${repository.runGuard()}) LIMIT 1`,
            {
              ...params(),
              expected_id: expected.id,
              expected_toolkit: expected.toolkit,
              expected_account: expected.connectedAccountId,
              expected_generation: int(expected.generation),
            },
          ),
        ),
        expected,
      ),
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
          `SELECT ${connectionColumns} FROM connections c
          WHERE c.owner_id=:connection_owner AND c.status='active' AND ${access}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)
          ORDER BY c.toolkit,c.id LIMIT 501`,
          { connection_owner: options.ownerId },
        ),
      );
      return rowsToConnections(rows);
    },
    snapshot: async () => {
      const [authorized, active] = await options.db.batch([
        sql(
          `SELECT id FROM users WHERE id=:connection_owner AND ${access}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)`,
          { connection_owner: options.ownerId },
        ),
        sql(
          `SELECT ${connectionColumns} FROM connections c
          WHERE c.owner_id=:connection_owner AND c.status='active' AND ${access}
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner)
          ORDER BY c.toolkit,c.id LIMIT 501`,
          { connection_owner: options.ownerId },
        ),
      ]);
      return {
        authorized: Boolean(authorized?.results.length),
        connections: rowsToConnections(active?.results ?? []),
      };
    },
    authorize: async (expected) =>
      exactConnection(
        await options.db.all(
          sql(
            `SELECT ${connectionColumns} FROM connections c
            WHERE c.id=:expected_id AND c.owner_id=:connection_owner
            AND c.toolkit=:expected_toolkit AND c.connected_account_id=:expected_account
            AND c.generation=:expected_generation AND c.status='active' AND ${access}
            AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:connection_owner) LIMIT 1`,
            {
              connection_owner: options.ownerId,
              expected_id: expected.id,
              expected_toolkit: expected.toolkit,
              expected_account: expected.connectedAccountId,
              expected_generation: int(expected.generation),
            },
          ),
        ),
        expected,
      ),
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
      `SELECT id, owner_id, toolkit, connected_account_id, generation, approval_mode
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
        approvalMode: connectionApprovalMode(row.approval_mode),
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
