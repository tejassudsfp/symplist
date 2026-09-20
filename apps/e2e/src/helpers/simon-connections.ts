import { localDataPaths } from "@symplist/config";
import { apiSecretFamilies } from "@symplist/config/api";
import { SimonApprovals, SimonRepository } from "@symplist/core/simon";
import { createEnvKeyProvider, encryptFieldText, zeroize } from "@symplist/crypto";
import { createLocalSqliteClient, int, sql, uuidv7 } from "@symplist/db";
import { readRunEnv } from "./local-api.ts";

export interface ScriptedConnectionAction {
  readonly connectionId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

function localResources() {
  const env = readRunEnv();
  const db = createLocalSqliteClient({
    path: localDataPaths(env.LOCAL_DATA_DIR ?? "").database,
    env,
  });
  const keys = createEnvKeyProvider(env, { families: apiSecretFamilies });
  const repository = new SimonRepository({
    db,
    keys,
    now: Date.now,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: Number(env.QUICK_CHAT_TTL_HOURS ?? 24),
  });
  return { db, keys, repository };
}

/** Seeds only the provider-confirmed identity that hosted OAuth would normally establish. */
export async function seedScriptedConnection(ownerId: string): Promise<{
  readonly connectionId: string;
  readonly alias: string;
}> {
  const { db, keys, repository } = localResources();
  const connectionId = uuidv7();
  const alias = "Browser contract Gmail";
  const key = await repository.accountKeys.load(ownerId);
  if (!key) throw new Error("the e2e account key is unavailable");
  try {
    const now = Date.now();
    await db.run(
      sql(
        `INSERT INTO connections
         (id,owner_id,toolkit,connected_account_id,alias_enc,status,confirmed_at,created_at,updated_at,write_id)
         VALUES(:id,:owner,'gmail',:account,:alias,'active',:now,:now,:now,:write)`,
        {
          id: connectionId,
          owner: ownerId,
          account: `ca_scripted_${connectionId}`,
          alias: encryptFieldText(
            key,
            {
              ownerId,
              table: "connections",
              rowId: connectionId,
              column: "alias_enc",
              purpose: "connection_alias",
            },
            alias,
          ),
          now: int(now),
          write: uuidv7(now),
        },
      ),
    );
    return { connectionId, alias };
  } finally {
    zeroize(key.key);
    keys.destroy();
    db.close?.();
  }
}

/** Encodes the bounded directive understood only by the explicit scripted model mode. */
export function scriptedConnectionDirective(input: ScriptedConnectionAction): string {
  return `symplist-e2e-connection-action:${Buffer.from(JSON.stringify(input), "utf8").toString("base64url")}`;
}

/** Reads the real encrypted approval and invocation ledger after the browser drives the flow. */
export async function latestScriptedConnectionAction(ownerId: string, taskId: string) {
  const { db, keys, repository } = localResources();
  try {
    const row = await db.first(
      sql(
        `SELECT id FROM approvals WHERE owner_id=:owner AND task_id=:task
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        { owner: ownerId, task: taskId },
      ),
    );
    if (!row) throw new Error("the scripted connector did not create an approval");
    const approval = await new SimonApprovals(repository).load(ownerId, String(row.id));
    const invocations = await db.all(
      sql(
        `SELECT status FROM tool_invocations
         WHERE owner_id=:owner AND approval_id=:approval ORDER BY started_at,id`,
        { owner: ownerId, approval: approval.id },
      ),
    );
    return {
      approval,
      invocationStatuses: invocations.map((invocation) => String(invocation.status)),
    };
  } finally {
    keys.destroy();
    db.close?.();
  }
}
