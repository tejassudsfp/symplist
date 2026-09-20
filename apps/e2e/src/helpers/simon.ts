import { localDataPaths } from "@symplist/config";
import { apiSecretFamilies } from "@symplist/config/api";
import { SimonApprovals, SimonRepository, SimonUserAsks } from "@symplist/core/simon";
import { createEnvKeyProvider } from "@symplist/crypto";
import { createLocalSqliteClient, int, sql, uuidv7 } from "@symplist/db";
import { type RunEnv, readRunEnv } from "./local-api.ts";

/** Seed a genuine encrypted pause, not a mocked HTTP response or an external provider call. */
export async function seedSimonPause(
  ownerId: string,
  taskId: string,
  kind: "question" | "approval",
  env: RunEnv = readRunEnv(),
) {
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
    quickChatTtlHours: 24,
  });
  try {
    const conversationId = await repository.createConversation(ownerId, taskId);
    // Cancel only this fixture owner's initial dispatch intent in its creation transaction. There
    // is no race with the API dispatcher; owner decisions later create normal continuation intents.
    const batch = db.batch.bind(db);
    db.batch = async (statements, options) => {
      const results = await batch(
        [
          ...statements,
          sql(
            "UPDATE dispatch_intents SET status='cancelled',cancelled_at=:now,updated_at=:now,write_id=:write WHERE owner_id=:owner AND kind='simon_run' AND status='pending'",
            { owner: ownerId, now: int(Date.now()), write: uuidv7() },
          ),
        ],
        options,
      );
      return results.slice(0, statements.length);
    };
    const accepted = await repository.acceptMessage(ownerId, conversationId, uuidv7(), {
      text: "Prepare a safe next step.",
      tier: "fast",
    });
    db.batch = batch;
    const claim = await repository.claim(accepted.runId ?? "", "local");
    if (!claim) throw new Error("could not claim fixture run");
    try {
      const toolCallId = "browser_pause";
      const pauseId = uuidv7();
      const question = "Which section should I work on next?";
      const snapshotJson = JSON.stringify({
        id: claim.run.id,
        role: "assistant",
        parts: [
          { type: "text", text: "I checked the outline." },
          {
            type: "dynamic-tool",
            toolName: kind === "question" ? "user_ask" : "execute_tools",
            toolCallId,
            state: "output-available",
            input: kind === "question" ? { question } : {},
            output:
              kind === "question"
                ? { status: "awaiting_user", askId: pauseId }
                : { status: "awaiting_approval", approvalId: pauseId },
          },
        ],
      });
      const checkpoint = { text: "I checked the outline.", steps: 1, snapshotJson };
      if (kind === "question") {
        await new SimonUserAsks(repository).pause(
          claim.run,
          claim.key,
          { question, toolCallId },
          checkpoint,
          pauseId,
        );
      } else {
        const connectionId = uuidv7();
        await db.run(
          sql(
            `INSERT INTO connections(id,owner_id,toolkit,connected_account_id,status,confirmed_at,created_at,updated_at,write_id)
          VALUES(:id,:owner,'gmail','ca_browser_fixture','active',:now,:now,:now,:id)`,
            { id: connectionId, owner: ownerId, now: int(Date.now()) },
          ),
        );
        await new SimonApprovals(repository).pause(
          claim.run,
          claim.key,
          {
            toolCallId,
            toolSlug: "GMAIL_SEND_EMAIL",
            connection: {
              id: connectionId,
              ownerId,
              toolkit: "gmail",
              connectedAccountId: "ca_browser_fixture",
              generation: 1,
            },
            arguments: {
              recipient: "collaborator@example.test",
              subject: "Project outline",
              body: "Please review the outline.",
            },
            preview: {
              recipient: "collaborator@example.test",
              subject: "Project outline",
              body: "Please review the outline.",
            },
            policyVersion: "browser-fixture",
          },
          checkpoint,
          pauseId,
        );
      }
      return { conversationId, runId: claim.run.id, pauseId };
    } finally {
      repository.releaseClaim(claim);
    }
  } finally {
    keys.destroy();
    db.close();
  }
}
