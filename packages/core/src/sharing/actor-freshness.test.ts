import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimonDocumentActor } from "../documents/actor.ts";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonDocumentSession } from "../simon/documents.ts";
import { SimonRepository } from "../simon/repository.ts";
import type { ClaimedSimonRun } from "../simon/types.ts";
import { SharingGrants } from "./grants.ts";
import { SharingRepository } from "./repository.ts";

let env: DocumentsTestEnvironment;
let simon: SimonRepository;
let claim: ClaimedSimonRun;
let session: SimonDocumentSession;
let repo: SharingRepository;
let grants: SharingGrants;
let task: string;
let revision: string;
let artifact: string;
let grant: string;
let actorExpiresAt: number;
const changes = ["stop", "generation", "mode", "expiry", "relock", "archive"] as const;
type Change = (typeof changes)[number];

function actor(): SimonDocumentActor {
  return {
    ...session.actor("sharing_call"),
    // The trusted executor owns guard construction. Refresh its clock-bound predicate on use.
    get guards() {
      return [
        ...(session.actor("sharing_call").guards ?? []),
        {
          sql: "CAST(:actor_now AS INTEGER) < CAST(:actor_expiry AS INTEGER)",
          params: {
            actor_now: int(env.clock),
            actor_expiry: int(actorExpiresAt),
          },
        },
      ];
    },
  };
}
function snapshotInput() {
  return { title: "Private snapshot", revision, sectionIds: [] };
}
function proposalInput() {
  return {
    artifactId: artifact,
    expectedHead: revision,
    mode: "link" as const,
    expiresAt: env.clock + 86_400_000,
  };
}
async function invalidate(change: Change) {
  if (change === "stop") await simon.stop(claim.run.ownerId, claim.run.id);
  if (change === "generation")
    await env.db.run(sql("UPDATE executor_state SET generation = generation + 1"));
  if (change === "mode") await env.db.run(sql("UPDATE executor_state SET mode = 'durable'"));
  if (change === "expiry") env.clock += 1000;
  if (change === "relock") await env.relock(claim.run.ownerId);
  if (change === "archive") await env.archiveTask(task);
}
async function counts() {
  return Promise.all(
    ["artifacts", "share_approvals", "share_grants", "share_audit"].map((table) =>
      env.count(table),
    ),
  );
}

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  await env.db.run(sql("UPDATE executor_state SET mode = 'local'"));
  const owner = await env.createUser();
  task = await env.createTask(owner);
  revision = String(
    (
      await env.tools.updateSection(env.simon(owner, task), {
        taskId: task,
        expectedRevision: null,
        placement: "end",
        markdown: "# Private source\nSharing fixture",
      })
    ).revision,
  );
  simon = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  const conversation = await simon.createConversation(owner, task);
  const accepted = await simon.acceptMessage(owner, conversation, "sharing-message", {
    text: "Prepare sharing",
    tier: "fast",
  });
  const claimed = await simon.claim(String(accepted.runId), "local");
  if (!claimed) throw new Error("Missing run claim");
  claim = claimed;
  session = await SimonDocumentSession.create({
    repository: simon,
    claim,
    tools: env.tools,
    git: null,
  });
  // Model a time-bounded trusted capability independently of task-chat lifecycle constraints.
  actorExpiresAt = env.clock + 1000;
  repo = new SharingRepository({
    db: env.db,
    objects: env.objects,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    artifactOrigin: "https://artifacts.example.test",
  });
  grants = new SharingGrants(repo);
  artifact = (await repo.snapshot(actor(), task, snapshotInput(), "initial-snapshot")).id;
  grant = uuidv7();
  await env.db.run(
    sql(
      `INSERT INTO share_grants (id, owner_id, artifact_id, mode, publication_id, created_at, write_id)
    VALUES (:id, :owner, :artifact, 'public', :publication, :now, :write)`,
      { id: grant, owner, artifact, publication: uuidv7(), now: int(env.clock), write: uuidv7() },
    ),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  simon.releaseClaim(claim);
  await env.close();
});

describe("Sharing trusted actor freshness", () => {
  it.each(["list", "proposal replay", "snapshot replay"] as const)(
    "checks cancellation in the deciding read for %s",
    async (operation) => {
      const input = proposalInput();
      await grants.propose(actor(), input, "race-proposal");
      const trusted = actor();
      const batch = env.db.batch.bind(env.db);
      let changed = false;
      vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
        if (!changed) {
          changed = true;
          await batch([
            sql("UPDATE runs SET cancel_requested_at = :now WHERE id = :run", {
              run: claim.run.id,
              now: int(env.clock),
            }),
          ]);
        }
        return batch(statements, options);
      });
      const result =
        operation === "list"
          ? repo.list(trusted, task)
          : operation === "proposal replay"
            ? grants.propose(trusted, input, "race-proposal")
            : repo.snapshot(trusted, task, snapshotInput(), "initial-snapshot");
      await expect(result).rejects.toMatchObject({ code: "not_found" });
      expect(changed).toBe(true);
    },
  );

  it("checks real quick-chat expiry for a referenced-task list", async () => {
    const conversation = await simon.createConversation(claim.run.ownerId, null);
    const accepted = await simon.acceptMessage(claim.run.ownerId, conversation, "quick-share", {
      text: "List referenced shares",
      tier: "fast",
    });
    const quick = await simon.claim(String(accepted.runId), "local");
    if (!quick) throw new Error("Missing quick run");
    try {
      const quickSession = await SimonDocumentSession.create({
        repository: simon,
        claim: quick,
        tools: env.tools,
        git: null,
      });
      expect((await repo.list(quickSession.actor("quick_list"), task)).artifacts).toHaveLength(1);
      env.clock += 86_400_000;
      await expect(repo.list(quickSession.actor("expired_list"), task)).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      simon.releaseClaim(quick);
    }
  });

  it("refreshes proposal guards when capability expiry wins after loading the artifact", async () => {
    const load = repo.loadArtifact.bind(repo);
    vi.spyOn(repo, "loadArtifact").mockImplementation(async (...args) => {
      const result = await load(...args);
      await invalidate("expiry");
      return result;
    });
    const before = await counts();
    await expect(
      grants.propose(actor(), proposalInput(), "expired-proposal"),
    ).rejects.toMatchObject({ code: "sharing.stale" });
    expect(await counts()).toEqual(before);
  });

  it.each(changes)(
    "rejects reads, snapshot/proposal replays and writes after %s",
    async (change) => {
      const input = proposalInput();
      const proposal = await grants.propose(actor(), input, "proposal-replay");
      expect(await grants.propose(actor(), input, "proposal-replay")).toEqual(proposal);
      expect((await repo.list(actor(), task)).artifacts).toHaveLength(1);
      const before = await counts();
      await invalidate(change);
      for (const operation of [
        () => repo.list(actor(), task),
        () => repo.snapshot(actor(), task, snapshotInput(), "initial-snapshot"),
        () => repo.snapshot(actor(), task, snapshotInput(), "new-snapshot"),
        () => grants.propose(actor(), input, "proposal-replay"),
        () => grants.propose(actor(), input, "proposal-new"),
        () => grants.revoke(actor(), artifact, grant),
      ])
        await expect(operation()).rejects.toMatchObject({ code: "not_found" });
      expect(await counts()).toEqual(before);
      expect(
        await env.db.first(
          sql("SELECT status, generation FROM share_grants WHERE id = :id", { id: grant }),
        ),
      ).toEqual({ status: "active", generation: 1 });
    },
  );

  it.each(changes)("fences a snapshot when %s wins during object upload", async (change) => {
    const before = await counts();
    const put = env.objects.put.bind(env.objects);
    vi.spyOn(env.objects, "put").mockImplementation(async (input) => {
      const result = await put(input);
      await invalidate(change);
      return result;
    });
    await expect(
      repo.snapshot(actor(), task, snapshotInput(), "late-snapshot"),
    ).rejects.toMatchObject({ code: "sharing.stale" });
    expect(await counts()).toEqual(before);
  });

  it.each(changes.filter((change) => change !== "expiry"))(
    "fences proposal writes when %s wins the deciding batch",
    async (change) => {
      const batch = env.db.batch.bind(env.db);
      let changed = false;
      vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
        if (
          !changed &&
          statements.some((statement) => statement.sql.startsWith("INSERT INTO share_approvals"))
        ) {
          changed = true;
          await invalidate(change);
        }
        return batch(statements, options);
      });
      const before = await counts();
      await expect(grants.propose(actor(), proposalInput(), "late-proposal")).rejects.toMatchObject(
        { code: "sharing.stale" },
      );
      expect(changed).toBe(true);
      expect(await counts()).toEqual(before);
    },
  );

  it.each(changes)("fences revocation when %s wins after its read", async (change) => {
    const load = repo.loadArtifact.bind(repo);
    vi.spyOn(repo, "loadArtifact").mockImplementation(async (...args) => {
      const result = await load(...args);
      await invalidate(change);
      return result;
    });
    const before = await counts();
    await expect(grants.revoke(actor(), artifact, grant)).rejects.toMatchObject({
      code: "sharing.stale",
    });
    expect(await counts()).toEqual(before);
    expect(
      await env.db.first(
        sql("SELECT status, generation FROM share_grants WHERE id = :id", { id: grant }),
      ),
    ).toEqual({ status: "active", generation: 1 });
  });
});
