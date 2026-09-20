import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeReadPositions,
  type ReceiptRecord,
  receiptFromRow,
  receiptStatement,
  selectReceiptsStatement,
} from "../receipts/receipts.ts";
import { buildSectionIndex } from "../sections/section-index.ts";
import {
  createDocsTestEnvironment,
  type DocsTestEnvironment,
} from "../test-support/environment.ts";
import { DocumentOrphanCollector } from "./orphans.ts";
import { contentDigest, type PublishInput } from "./publisher.ts";
import { DocumentHistoryReader } from "./reader.ts";
import { repoFromRow, selectRepoStatement } from "./records.ts";

let env: DocsTestEnvironment;
let owner: string;
let task: string;

beforeEach(async () => {
  env = await createDocsTestEnvironment();
  owner = await env.createUser();
  task = await env.createTask(owner);
});

afterEach(async () => {
  await env.close();
});

function input(
  markdown: string,
  requestId: string,
  base: string | null,
  extra: Partial<PublishInput> = {},
): PublishInput {
  return {
    ownerId: owner,
    taskId: task,
    scope: "save",
    requestId,
    fingerprint: { content: contentDigest(markdown), base },
    expectedBase: base,
    author: "user",
    now: env.now,
    context: env.context(owner, task),
    edit: () => ({ kind: "edit", markdown }),
    ...extra,
  };
}

async function publish(
  markdown: string,
  requestId: string,
  base: string | null,
  extra: Partial<PublishInput> = {},
) {
  const outcome = await env.publisher().publish(input(markdown, requestId, base, extra));
  if (outcome.status !== "published") throw new Error(outcome.status);
  env.now += 1_000;
  return outcome.document;
}

async function repo() {
  const row = await env.db.first(selectRepoStatement(owner, task));
  if (!row) throw new Error("no repo");
  return repoFromRow(row);
}

describe("history and diffs from Git (§9.2)", () => {
  it("pages provenance from the encrypted history and bounds diffs between published commits", async () => {
    const first = await publish("# Plan\n\nOne\n", "r1", null);
    const second = await publish("# Plan\n\nTwo\n", "r2", first.commitId, { author: "simon" });
    const third = await publish("# Plan\n\nTwo\n\n## Links\nx\n", "r3", second.commitId, {
      author: "mcp",
    });
    const reader = new DocumentHistoryReader({ git: env.git, artifacts: env.artifacts });
    const key = await env.accountKey(owner);
    const head = await repo();
    const page = await reader.history(head, key, { pinnedHead: third.commitId, skip: 0, limit: 2 });
    expect(page.map((entry) => [entry.author, entry.kind, entry.subject])).toEqual([
      ["mcp", "edit", "Added Links"],
      ["simon", "edit", "Updated Plan"],
    ]);
    const rest = await reader.history(head, key, { pinnedHead: third.commitId, skip: 2, limit: 2 });
    expect(rest.map((entry) => entry.commitId)).toEqual([first.commitId]);
    const pinned = await reader.history(head, key, {
      pinnedHead: second.commitId,
      skip: 0,
      limit: 5,
    });
    expect(pinned.map((entry) => entry.commitId)).toEqual([second.commitId, first.commitId]);

    const hunks = await reader.diff(head, key, { base: first.commitId, target: third.commitId });
    const lines = hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context");
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["removed", "One"],
      ["added", "Two"],
      ["added", ""],
      ["added", "## Links"],
      ["added", "x"],
    ]);
    await expect(
      reader.diff(head, key, { base: third.commitId, target: first.commitId }),
    ).rejects.toMatchObject({
      code: "document.resync_required",
    });
    await expect(
      reader.diff(head, key, { base: "f".repeat(40), target: third.commitId }),
    ).rejects.toMatchObject({
      code: "document.resync_required",
    });
    expect(await env.git.tempRoot.list()).toEqual([]);
  });
});

describe("orphan collection (§9.2)", () => {
  it("deletes only unreferenced objects older than the grace period and keeps history", async () => {
    const first = await publish("# One\n", "r1", null);
    const crashing = env.publisher({
      hooks: {
        afterUpload: () => {
          throw new Error("crash after upload");
        },
      },
    });
    await expect(
      crashing.publish(input("# One\n\nOrphan\n", "r-orphan", first.commitId)),
    ).rejects.toThrow();
    let base = first.commitId;
    for (let n = 2; n <= 6; n += 1)
      base = (await publish(`# One\n\n${n}\n`, `r${n}`, base)).commitId;
    const before = (await env.objects.list({ prefix: `u/${owner}/` })).objects.map(
      (object) => object.key,
    );
    expect(before.filter((key) => key.includes("/bundles/"))).toHaveLength(7);
    expect(before.filter((key) => key.includes("/docs/"))).toHaveLength(7);

    const collector = new DocumentOrphanCollector({
      db: env.db,
      objects: env.objects,
      graceMs: 60_000,
      keepBundles: 2,
    });
    // Within the grace period nothing is touched.
    expect(await collector.collectOwner(owner, Date.now())).toMatchObject({
      deletedBundles: 0,
      deletedSnapshots: 0,
    });
    // After it, the orphan bundle and snapshot and the superseded bundles beyond retention go.
    const result = await collector.collectOwner(owner, Date.now() + 10 * 60_000);
    expect(result).toMatchObject({ deletedSnapshots: 1, complete: true });
    expect(result.deletedBundles).toBe(1 + 3);
    const after = (await env.objects.list({ prefix: `u/${owner}/` })).objects.map(
      (object) => object.key,
    );
    const head = await repo();
    expect(after).toContain(head.bundleKey);
    expect(after.filter((key) => key.includes("/docs/"))).toHaveLength(6);
    // The head still reconstructs with the complete history.
    const reader = new DocumentHistoryReader({ git: env.git, artifacts: env.artifacts });
    const history = await reader.history(head, await env.accountKey(owner), {
      pinnedHead: head.headCommitId,
      skip: 0,
      limit: 10,
    });
    expect(history).toHaveLength(6);
  });

  it("sweeps owners in bounded pages and removes expired job objects", async () => {
    await publish("# One\n", "r1", null);
    await env.objects.put({
      key: `u/${owner}/jobs/0192f0a0-0000-7000-8000-000000000999/call_1.in.sym`,
      body: new Uint8Array([1]),
    });
    const collector = new DocumentOrphanCollector({
      db: env.db,
      objects: env.objects,
      graceMs: 1_000,
      jobRetentionMs: 1_000,
    });
    const pass = await collector.sweep({ now: Date.now() + 60_000, maxOwners: 10 });
    expect(pass).toMatchObject({
      deletedJobs: 1,
      nextOwnerId: null,
      deletedBundles: 0,
      deletedSnapshots: 0,
    });
  });
});

describe("read receipts and positions (§9.4)", () => {
  it("records delivered ranges idempotently for published commits of the owner's task only", async () => {
    const first = await publish("## A\none\n\n## B\ntwo\n", "r1", null);
    const index = buildSectionIndex("## A\none\n\n## B\ntwo\n", first.commitId);
    const section = index.sections[0];
    if (!section) throw new Error("missing");
    const draft = {
      ownerId: owner,
      taskId: task,
      reader: { kind: "conversation" as const, id: "0192f0a0-0000-7000-8000-000000000501" },
      sectionId: section.id,
      commitId: first.commitId,
      rangeStart: 0,
      rangeEnd: section.end - section.start,
      sectionLength: section.end - section.start,
      contextEpoch: 0,
      runId: null,
      deliveredBytes: section.bytes,
    };
    await env.db.batch([receiptStatement(draft, env.now), receiptStatement(draft, env.now + 1)]);
    const otherTask = await env.createTask(owner);
    await env.db.run(receiptStatement({ ...draft, taskId: otherTask }, env.now));
    const intruder = await env.createUser();
    await env.db.run(receiptStatement({ ...draft, ownerId: intruder }, env.now));
    const rows = await env.db.all(sql(`SELECT * FROM read_receipts`));
    expect(rows).toHaveLength(1);
    const loaded = (await env.db.all(selectReceiptsStatement(owner, task, draft.reader, 10))).map(
      receiptFromRow,
    );
    expect(loaded).toHaveLength(1);
  });

  it("distinguishes read, partial, changed, unread, previously read and removed sections", () => {
    const old = buildSectionIndex(
      "## A\none\n\n## B\ntwo\n\n## C\nthree\n\n## D\nfour\n",
      "a".repeat(40),
    );
    const head = buildSectionIndex(
      "## A\none\n\n## B\nTWO\n\n## C\nthree\n\n## E\nnew\n",
      "b".repeat(40),
    );
    const receipt = (
      index: typeof old,
      position: number,
      epoch: number,
      partial = false,
    ): ReceiptRecord => {
      const section = index.sections[position];
      if (!section) throw new Error("missing");
      const length = section.end - section.start;
      return {
        sectionId: section.id,
        commitId: index.commitId,
        rangeStart: 0,
        rangeEnd: partial ? 2 : length,
        sectionLength: length,
        contextEpoch: epoch,
        createdAt: 1,
      };
    };
    const { sections, removed } = computeReadPositions({
      head,
      indexes: new Map([[old.commitId, old]]),
      contextEpoch: 2,
      receipts: [
        receipt(old, 0, 2),
        receipt(old, 1, 2),
        receipt(head, 2, 2, true),
        receipt(old, 3, 2),
        receipt(old, 2, 1),
      ],
    });
    expect(sections.map((section) => [section.heading, section.state])).toEqual([
      ["A", "read"],
      ["B", "changed_since_read"],
      ["C", "partially_read"],
      ["E", "unread"],
    ]);
    expect(removed.map((section) => section.heading)).toEqual(["D"]);
    const compacted = computeReadPositions({
      head,
      indexes: new Map([[old.commitId, old]]),
      contextEpoch: 3,
      receipts: [receipt(old, 0, 2)],
    });
    expect(compacted.sections[0]?.state).toBe("previously_read");
  });
});
