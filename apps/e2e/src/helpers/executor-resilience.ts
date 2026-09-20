import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localDataPaths } from "@symplist/config";
import { apiSecretFamilies } from "@symplist/config/api";
import {
  SimonApprovals,
  SimonExecutionTracker,
  SimonInvocations,
  SimonRepository,
} from "@symplist/core/simon";
import { createEnvKeyProvider, zeroize } from "@symplist/crypto";
import { createLocalSqliteClient, int, sql, uuidv7 } from "@symplist/db";
import { readRunEnv } from "./local-api.ts";
import { seedSimonPause } from "./simon.ts";

export interface UncertainEffectProof {
  readonly approvalId: string;
  readonly conversationId: string;
  readonly interruptedRunId: string;
  readonly firstOutcome: "uncertain";
  readonly restartedOutcome: "uncertain";
  readonly invocationCount: number;
  readonly invocationStatus: string;
  readonly effectObjectCount: number;
  readonly replayObjectCount: number;
}

function runtime() {
  const env = readRunEnv();
  const paths = localDataPaths(env.LOCAL_DATA_DIR ?? "");
  const db = createLocalSqliteClient({ path: paths.database, env });
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

function markerDirectory(ownerId: string, approvalId: string): string {
  const env = readRunEnv();
  return join(env.LOCAL_DATA_DIR ?? "", "provider-effects", ownerId, approvalId);
}

async function markers(ownerId: string, approvalId: string): Promise<readonly string[]> {
  try {
    return await readdir(markerDirectory(ownerId, approvalId));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Performs one provider-bound effect, loses its response, then recreates every repository/key
 * object and replays the continuation. The production invocation ledger must return `uncertain`
 * without calling the second effect. Finally the production tracker models restart reconciliation.
 */
export async function seedUncertainEffectRestart(
  ownerId: string,
  taskId: string,
): Promise<UncertainEffectProof> {
  const pause = await seedSimonPause(ownerId, taskId, "approval");
  const markerDir = markerDirectory(ownerId, pause.pauseId);
  const acceptedPath = join(markerDir, "accepted.json");
  const replayedPath = join(markerDir, "replayed.json");
  let interruptedRunId = "";
  let firstOutcome: "uncertain" = "uncertain";

  const first = runtime();
  try {
    const approvals = new SimonApprovals(first.repository);
    const approval = await approvals.load(ownerId, pause.pauseId);
    // This fixture claims the continuation itself. Cancel its dispatcher intent in the decision's
    // transaction so a kick from a parallel browser worker cannot race the production ledger proof.
    const batch = first.db.batch.bind(first.db);
    first.db.batch = async (statements, options) => {
      const now = Date.now();
      const results = await batch(
        [
          ...statements,
          sql(
            `UPDATE dispatch_intents SET status='cancelled',cancelled_at=:now,updated_at=:now,write_id=:write
             WHERE owner_id=:owner AND kind='simon_run' AND status='pending'
             AND subject_id IN (SELECT id FROM runs WHERE owner_id=:owner AND approval_id=:approval)`,
            {
              owner: ownerId,
              approval: pause.pauseId,
              now: int(now),
              write: uuidv7(now),
            },
          ),
        ],
        options,
      );
      return results.slice(0, statements.length);
    };
    let continuation: Awaited<ReturnType<SimonApprovals["decide"]>>;
    try {
      continuation = await approvals.decide(ownerId, pause.pauseId, {
        decision: "approve",
        argDigest: approval.argDigest,
      });
    } finally {
      first.db.batch = batch;
    }
    interruptedRunId = continuation.runId;
    const claim = await first.repository.claim(continuation.runId, "local");
    if (!claim) throw new Error("could not claim the approved continuation");
    try {
      const outcome = await new SimonInvocations(first.repository).executeApproved(
        claim.run,
        claim.key,
        pause.pauseId,
        async ({ idempotencyKey }) => {
          if (idempotencyKey !== pause.pauseId)
            throw new Error("the provider effect received the wrong idempotency key");
          await mkdir(markerDir, { recursive: true });
          await writeFile(acceptedPath, '{"accepted":true}', { flag: "wx", mode: 0o600 });
          // The provider accepted the action, but its response never reached the executor.
          throw new Error("provider response lost after acceptance");
        },
      );
      if (outcome.status !== "uncertain") throw new Error("the lost response was not uncertain");
      firstOutcome = outcome.status;
    } finally {
      first.repository.releaseClaim(claim);
    }
  } finally {
    first.keys.destroy();
    first.db.close();
  }

  // A fresh database connection, key provider, repository and ledger model a new executor process.
  const restarted = runtime();
  let restartedOutcome: "uncertain" = "uncertain";
  try {
    const run = await restarted.repository.run(ownerId, interruptedRunId);
    if (!run) throw new Error("the continuation did not survive restart");
    const key = await restarted.repository.accountKeys.require(ownerId);
    try {
      const outcome = await new SimonInvocations(restarted.repository).executeApproved(
        run,
        key,
        pause.pauseId,
        async () => {
          await mkdir(markerDir, { recursive: true });
          await writeFile(replayedPath, '{"replayed":true}', { flag: "wx", mode: 0o600 });
          return { status: "succeeded", result: { replayed: true } };
        },
      );
      if (outcome.status !== "uncertain") throw new Error("restart did not reuse uncertainty");
      restartedOutcome = outcome.status;
    } finally {
      zeroize(key.key);
    }
    if (
      !(await new SimonExecutionTracker(restarted.db).markInterrupted(interruptedRunId, {
        outcomeCode: "executor_lost",
        now: Date.now(),
      }))
    )
      throw new Error("restart reconciliation did not interrupt the active run");

    const invocation = await restarted.db.first(
      sql(
        "SELECT COUNT(*) AS count,MAX(status) AS status FROM tool_invocations WHERE owner_id=:owner AND approval_id=:approval",
        { owner: ownerId, approval: pause.pauseId },
      ),
    );
    const effectMarkers = await markers(ownerId, pause.pauseId);
    return {
      approvalId: pause.pauseId,
      conversationId: pause.conversationId,
      interruptedRunId,
      firstOutcome,
      restartedOutcome,
      invocationCount: Number(invocation?.count ?? 0),
      invocationStatus: String(invocation?.status ?? ""),
      effectObjectCount: effectMarkers.filter((item) => item === "accepted.json").length,
      replayObjectCount: effectMarkers.filter((item) => item === "replayed.json").length,
    };
  } finally {
    restarted.keys.destroy();
    restarted.db.close();
  }
}

/** Reads the persisted proof after the browser has driven the real Retry HTTP/executor path. */
export async function uncertainEffectState(ownerId: string, approvalId: string) {
  const active = runtime();
  try {
    const invocation = await active.db.first(
      sql(
        "SELECT COUNT(*) AS count,MAX(status) AS status FROM tool_invocations WHERE owner_id=:owner AND approval_id=:approval",
        { owner: ownerId, approval: approvalId },
      ),
    );
    const effectMarkers = await markers(ownerId, approvalId);
    return {
      invocationCount: Number(invocation?.count ?? 0),
      invocationStatus: String(invocation?.status ?? ""),
      effectObjectCount: effectMarkers.filter((item) => item === "accepted.json").length,
      replayObjectCount: effectMarkers.filter((item) => item === "replayed.json").length,
    };
  } finally {
    active.keys.destroy();
    active.db.close();
  }
}
