import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableDocumentGit } from "../documents/git-jobs.ts";
import { createDocumentsTestEnvironment } from "../documents/test-support.ts";
import { SimonDocumentSession } from "./documents.ts";
import { SimonQuickChats } from "./quick.ts";
import { SimonRepository } from "./repository.ts";
import { SimonSharingSession } from "./sharing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(executor: "local" | "trigger", quick = false) {
  const env = await createDocumentsTestEnvironment();
  cleanups.push(() => env.close());
  const owner = await env.createUser();
  const task = await env.createTask(owner);
  const revision = String(
    (
      await env.tools.updateSection(env.simon(owner, task), {
        taskId: task,
        expectedRevision: null,
        placement: "end",
        markdown: "# Private source\nPRIVATE-DOCUMENT-MARKER",
      })
    ).revision,
  );
  await env.db.run(
    sql("UPDATE executor_state SET mode = :mode", {
      mode: executor === "trigger" ? "durable" : "local",
    }),
  );
  const repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  const conversation = await repository.createConversation(owner, quick ? null : task);
  const accepted = await repository.acceptMessage(owner, conversation, "sharing-native", {
    text: "Prepare sharing",
    tier: "fast",
  });
  const claim = await repository.claim(String(accepted.runId), executor);
  if (!claim) throw new Error("Missing claim");
  cleanups.unshift(async () => repository.releaseClaim(claim));
  const documents = await SimonDocumentSession.create({
    repository,
    claim,
    tools: env.tools,
    git:
      executor === "local"
        ? null
        : new DurableDocumentGit({
            artifacts: env.repository.artifacts,
            now: () => env.clock,
            triggerAndWait: async () => {
              throw new Error("Sharing must not call Git");
            },
          }),
  });
  const session = new SimonSharingSession(documents, {
    objects: env.objects,
    privateOrigins: ["https://app.example.test"],
  });
  const input = { title: "PRIVATE-TITLE-MARKER", revision, sectionIds: [] };
  return { env, repository, claim, documents, session, owner, task, revision, input };
}

describe.each(["local", "trigger"] as const)("native Sharing %s", (executor) => {
  it("pins encrypted snapshots and handoff placeholders; proposals never mint a capability", async () => {
    const { env, session, task, revision, input, owner } = await fixture(executor);
    const release = vi.spyOn(session.grants, "release");
    const artifact = await session.snapshot(task, input, "snapshot");
    expect(await session.snapshot(task, input, "snapshot")).toEqual(artifact);
    await expect(
      session.snapshot(task, { ...input, title: "Changed" }, "snapshot"),
    ).rejects.toMatchObject({ code: "idempotency.mismatch" });
    const proposalInput = {
      artifactId: artifact.artifactId,
      expectedHead: revision,
      mode: "link" as const,
      expiresAt: env.clock + 86_400_000,
    };
    const proposal = await session.propose(proposalInput, "proposal");
    expect(await session.propose(proposalInput, "proposal")).toEqual(proposal);
    await expect(
      session.propose({ ...proposalInput, mode: "password" }, "proposal"),
    ).rejects.toMatchObject({ code: "idempotency.mismatch" });
    const handoffInput = {
      title: "Private draft",
      revision,
      target: "coding_assistant" as const,
      prompt: "Implement the objective. https://recipient.test/s?key=RAW-CAPABILITY-MARKER",
      artifactIds: [artifact.artifactId],
    };
    const handoff = await session.handoff(task, handoffInput, "handoff");
    expect(await session.handoff(task, handoffInput, "handoff")).toEqual(handoff);
    expect(handoff.status).toBe("draft");
    const preview = await session.repository.preview(owner, handoff.artifactId);
    expect(JSON.stringify(preview)).toContain(`{{artifact:${artifact.artifactId}}}`);
    expect(JSON.stringify(preview)).not.toContain("RAW-CAPABILITY-MARKER");
    const listing = await session.list(task, {}, "list");
    expect(listing.artifacts).toHaveLength(2);
    expect(await env.count("share_approvals")).toBe(1);
    expect(await env.count("share_grants")).toBe(0);
    expect(release).not.toHaveBeenCalled();
    const modelOutputs = JSON.stringify({ artifact, proposal, handoff, listing });
    for (const marker of [
      "PRIVATE-TITLE-MARKER",
      "PRIVATE-DOCUMENT-MARKER",
      "RAW-CAPABILITY-MARKER",
      "https://",
      "token",
      "passwordHash",
    ])
      expect(modelOutputs).not.toContain(marker);
    const persisted = await env.db.all(sql("SELECT title_enc,fingerprint_enc FROM artifacts"));
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE-TITLE-MARKER");
  });

  it("folds revocation with exact durable replay and rejects a cancelled replay", async () => {
    const { env, session, task, input, owner, repository, claim } = await fixture(executor);
    const artifact = await session.snapshot(task, input, "snapshot");
    const grant = uuidv7();
    await env.db.run(
      sql(
        `INSERT INTO share_grants (id,owner_id,artifact_id,mode,publication_id,created_at,write_id)
      VALUES (:id,:owner,:artifact,'public',:publication,:now,:write)`,
        {
          id: grant,
          owner,
          artifact: artifact.artifactId,
          publication: uuidv7(),
          now: int(env.clock),
          write: uuidv7(),
        },
      ),
    );
    const result = await session.revoke(artifact.artifactId, grant, "revoke");
    expect(result).toMatchObject({ status: "revoked", grantId: grant, generation: 2 });
    const audits = await env.count("share_audit");
    // New wrapper, same claimed run: no process-local replay cache.
    const resumed = new SimonSharingSession(session.documents, { objects: env.objects });
    expect(await resumed.revoke(artifact.artifactId, grant, "revoke")).toEqual(result);
    expect(await env.count("share_audit")).toBe(audits);
    const receipt = await env.db.first(
      sql(
        "SELECT expires_at,response_enc FROM idempotency_records WHERE scope='simon.native.sharing'",
      ),
    );
    expect(receipt?.expires_at).toBe(Number.MAX_SAFE_INTEGER);
    expect(String(receipt?.response_enc)).toMatch(/^sym1\./);
    const otherGrant = uuidv7();
    await env.db.run(
      sql(
        `INSERT INTO share_grants (id,owner_id,artifact_id,mode,publication_id,created_at,write_id)
      VALUES (:id,:owner,:artifact,'public',:publication,:now,:write)`,
        {
          id: otherGrant,
          owner,
          artifact: artifact.artifactId,
          publication: uuidv7(),
          now: int(env.clock),
          write: uuidv7(),
        },
      ),
    );
    await expect(resumed.revoke(artifact.artifactId, otherGrant, "revoke")).rejects.toMatchObject({
      code: "idempotency.mismatch",
    });
    expect(
      await env.db.first(
        sql("SELECT status,generation FROM share_grants WHERE id=:id", { id: otherGrant }),
      ),
    ).toEqual({ status: "active", generation: 1 });
    await repository.stop(owner, claim.run.id);
    await expect(resumed.revoke(artifact.artifactId, grant, "revoke")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await env.count("share_audit")).toBe(audits);
  });

  it.each([false, true])("fences revocation at the deciding batch (replay=%s)", async (replay) => {
    const { env, session, task, input, owner, repository, claim } = await fixture(executor);
    const artifact = await session.snapshot(task, input, "snapshot");
    const grant = uuidv7();
    await env.db.run(
      sql(
        `INSERT INTO share_grants (id,owner_id,artifact_id,mode,publication_id,created_at,write_id)
      VALUES (:id,:owner,:artifact,'public',:publication,:now,:write)`,
        {
          id: grant,
          owner,
          artifact: artifact.artifactId,
          publication: uuidv7(),
          now: int(env.clock),
          write: uuidv7(),
        },
      ),
    );
    if (replay) await session.revoke(artifact.artifactId, grant, "revoke");
    const before = await env.count("share_audit");
    const batch = env.db.batch.bind(env.db);
    let raced = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (!raced && statements.some((statement) => statement.sql.includes("SELECT 1 AS allowed"))) {
        raced = true;
        await repository.stop(owner, claim.run.id);
      }
      return batch(statements, options);
    });
    await expect(session.revoke(artifact.artifactId, grant, "revoke")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(raced).toBe(true);
    expect(await env.count("share_audit")).toBe(before);
    expect(
      await env.db.first(
        sql("SELECT status,generation FROM share_grants WHERE id=:id", { id: grant }),
      ),
    ).toEqual({ status: replay ? "revoked" : "active", generation: replay ? 2 : 1 });
    expect(await env.count("idempotency_records")).toBe(replay ? 1 : 0);
  });

  it("cleans only retained native receipt scopes when quick history is deleted", async () => {
    const { env, owner, claim, repository } = await fixture(executor, true);
    for (const scope of ["simon.native.sharing", "simon.native.task", "simon.quick.close"]) {
      await env.db.run(
        sql(
          `INSERT INTO idempotency_records
        (scope,user_id,key,fingerprint,fingerprint_version,status,write_id,created_at,updated_at,expires_at)
        VALUES (:scope,:owner,:key,'test-fingerprint',1,'pending',:write,:now,:now,:expiry)`,
          {
            scope,
            owner,
            key: `${claim.run.id}:cleanup`,
            write: uuidv7(),
            now: int(env.clock),
            expiry: int(Number.MAX_SAFE_INTEGER),
          },
        ),
      );
    }
    await new SimonQuickChats(repository).close(owner, claim.run.conversationId);
    expect(await env.db.all(sql("SELECT scope FROM idempotency_records"))).toEqual([
      { scope: "simon.quick.close" },
    ]);
    expect(await env.count("runs")).toBe(0);
  });

  it.each(["stop", "generation", "mode", "relock"] as const)(
    "rejects %s before reads and exact mutation replays",
    async (change) => {
      const { env, session, task, input, owner, repository, claim, revision } =
        await fixture(executor);
      const artifact = await session.snapshot(task, input, "snapshot");
      const proposal = {
        artifactId: artifact.artifactId,
        expectedHead: revision,
        mode: "public" as const,
        expiresAt: null,
      };
      await session.propose(proposal, "proposal");
      if (change === "stop") await repository.stop(owner, claim.run.id);
      if (change === "generation")
        await env.db.run(sql("UPDATE executor_state SET generation=generation+1"));
      if (change === "mode")
        await env.db.run(
          sql("UPDATE executor_state SET mode=:mode", {
            mode: executor === "local" ? "durable" : "local",
          }),
        );
      if (change === "relock") await env.relock(owner);
      for (const work of [
        () => session.list(task, {}, "list"),
        () => session.snapshot(task, input, "snapshot"),
        () => session.propose(proposal, "proposal"),
      ])
        await expect(work()).rejects.toMatchObject({ code: "not_found" });
      expect(await env.count("artifacts")).toBe(1);
      expect(await env.count("share_approvals")).toBe(1);
    },
  );

  it("rejects another owner's reads and same-owner different-task mutations", async () => {
    const { env, session, owner, input } = await fixture(executor);
    const foreignTask = await env.createTask(await env.createUser());
    await expect(session.list(foreignTask, {}, "foreign")).rejects.toMatchObject({
      code: "not_found",
    });
    const otherTask = await env.createTask(owner);
    await expect(session.snapshot(otherTask, input, "other")).rejects.toMatchObject({
      code: "document.read_only",
    });
    expect(await env.count("artifacts")).toBe(0);
  });

  it("permits bounded quick reads only while the conversation is live", async () => {
    const { env, session, task, input } = await fixture(executor, true);
    expect((await session.list(task, {}, "list")).artifacts).toEqual([]);
    await expect(session.snapshot(task, input, "snapshot")).rejects.toMatchObject({
      code: "document.read_only",
    });
    env.clock += 25 * 3_600_000;
    await expect(session.list(task, {}, "expired")).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("artifacts")).toBe(0);
  });
});
