import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptObject, zeroize } from "@symplist/crypto";
import {
  type BatchOptions,
  type DbClient,
  type DbRow,
  DbUnknownOutcomeError,
  type LocalSqliteClient,
  type Statement,
  type StatementResult,
  sql,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleEnvelopeContext, parseBundleObjectKey } from "../artifacts/keys.ts";
import { DocumentError } from "../errors.ts";
import { findGitExecutable } from "../git/environment.ts";
import {
  createDocsTestEnvironment,
  type DocsTestEnvironment,
} from "../test-support/environment.ts";
import { contentDigest, type PublishInput } from "./publisher.ts";

let env: DocsTestEnvironment;
let owner: string;
let task: string;

/** A DbClient that can lose the response of the next publication batch, before or after it runs. */
class FlakyDb implements DbClient {
  mode: "none" | "before" | "after" = "none";
  constructor(private readonly inner: LocalSqliteClient) {}
  async batch(
    statements: readonly Statement[],
    options?: BatchOptions,
  ): Promise<readonly StatementResult[]> {
    const publication = statements.some((statement) => /INTO doc_commits/.test(statement.sql));
    if (publication && this.mode === "before") {
      this.mode = "none";
      throw new DbUnknownOutcomeError("network");
    }
    const results = await this.inner.batch(statements, options);
    if (publication && this.mode === "after") {
      this.mode = "none";
      throw new DbUnknownOutcomeError("timeout");
    }
    return results;
  }
  async all<Row extends DbRow = DbRow>(statement: Statement, options?: BatchOptions) {
    return ((await this.batch([statement], options))[0]?.results ?? []) as readonly Row[];
  }
  async first<Row extends DbRow = DbRow>(statement: Statement, options?: BatchOptions) {
    return ((await this.all<Row>(statement, options))[0] ?? null) as Row | null;
  }
  async run(statement: Statement, options?: BatchOptions) {
    return (await this.batch([statement], options))[0] as StatementResult;
  }
}

let flaky: FlakyDb;

beforeEach(async () => {
  env = await createDocsTestEnvironment({
    db: (db) => {
      flaky = new FlakyDb(db);
      return flaky;
    },
  });
  owner = await env.createUser();
  task = await env.createTask(owner);
});

afterEach(async () => {
  await env.close();
});

function input(
  markdown: string,
  requestId: string,
  expectedBase: string | null,
  extra: Partial<PublishInput> = {},
): PublishInput {
  return {
    ownerId: owner,
    taskId: task,
    scope: "save",
    requestId,
    fingerprint: { content: contentDigest(markdown), base: expectedBase },
    expectedBase,
    author: "user",
    now: env.now,
    context: env.context(owner, task),
    edit: () => ({ kind: "edit", markdown }),
    ...extra,
  };
}

async function published(
  markdown: string,
  requestId: string,
  base: string | null,
  extra: Partial<PublishInput> = {},
) {
  const outcome = await env.publisher().publish(input(markdown, requestId, base, extra));
  if (outcome.status !== "published") throw new Error(`expected published, got ${outcome.status}`);
  return outcome.document;
}

async function count(table: string): Promise<number> {
  const row = await env.db.first(sql(`SELECT COUNT(*) AS n FROM ${table}`));
  return row?.n as number;
}

async function objectKeys(): Promise<string[]> {
  return (await env.objects.list({ prefix: `u/${owner}/` })).objects.map((object) => object.key);
}

describe("publication protocol (§9.2)", () => {
  it("publishes real commits with parents, an index, a request record, a search intent and encrypted artifacts", async () => {
    const first = await published("## Overview\nA lighter portfolio.\n", "req-1", null);
    expect(first).toMatchObject({
      generation: 1,
      parentCommitId: null,
      kind: "create",
      author: "user",
    });
    env.now += 60_000;
    const second = await published(
      "## Overview\nA lighter portfolio.\n\n## Next steps\n1. Draft the about page\n",
      "req-2",
      first.commitId,
      { author: "simon" },
    );
    expect(second).toMatchObject({
      generation: 2,
      parentCommitId: first.commitId,
      kind: "edit",
      author: "simon",
    });
    expect(second.changedSectionIds).toHaveLength(1);

    const repo = await env.db.first(sql(`SELECT * FROM doc_repos WHERE task_id = :task`, { task }));
    expect(repo).toMatchObject({
      head_commit_id: second.commitId,
      generation: 2,
      commit_count: 2,
      head_author: "simon",
    });
    expect(await count("doc_commits")).toBe(2);
    expect(await count("doc_publish_requests")).toBe(2);
    const intents = await env.db.all(
      sql(`SELECT entity, entity_id, revision_or_seq, op FROM search_intents`),
    );
    expect(intents).toEqual([
      { entity: "document", entity_id: task, revision_or_seq: 1, op: "upsert" },
      { entity: "document", entity_id: task, revision_or_seq: 2, op: "upsert" },
    ]);
    const keys = await objectKeys();
    expect(keys.filter((key) => key.includes("/bundles/"))).toHaveLength(2);
    expect(keys).toContain(`u/${owner}/docs/${task}/${second.commitId}.md.sym`);
    // Nothing user-authored is stored in plaintext.
    const plain = JSON.stringify(await env.db.all(sql(`SELECT * FROM doc_publish_requests`)));
    expect(plain).not.toContain("lighter portfolio");
    const snapshot = await env.artifacts.getSnapshot(await env.accountKey(owner), {
      ownerId: owner,
      taskId: task,
      commitId: second.commitId,
    });
    expect(snapshot.subject).toBe("Added Next steps");
    expect(snapshot.index.sections.map((section) => section.heading)).toEqual([
      "Overview",
      "Next steps",
    ]);
    expect(await env.git.tempRoot.list()).toEqual([]);
  });

  it("produces bundles that standard Git can inspect after decrypting", async () => {
    const gitPath = findGitExecutable();
    if (!gitPath) throw new Error("Git is required for this test");
    const first = await published("# Plan\n", "req-a", null);
    env.now += 1_000;
    const second = await published("# Plan\n\nMore\n", "req-b", first.commitId, {
      author: "simon",
    });
    const repo = await env.db.first(
      sql(`SELECT bundle_key FROM doc_repos WHERE task_id = :task`, { task }),
    );
    const key = repo?.bundle_key as string;
    const ref = parseBundleObjectKey(key);
    if (!ref) throw new Error("bad key");
    const stored = await env.objects.get(key);
    const accountKey = await env.accountKey(owner);
    const bundle = decryptObject(
      accountKey,
      bundleEnvelopeContext(ref),
      stored?.body as Uint8Array,
    );
    zeroize(accountKey.key);
    const scratch = mkdtempSync(join(tmpdir(), "symplist-inspect-"));
    try {
      writeFileSync(join(scratch, "doc.bundle"), bundle);
      execFileSync(
        gitPath,
        [
          "clone",
          "--quiet",
          "--branch",
          "main",
          join(scratch, "doc.bundle"),
          join(scratch, "clone"),
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: scratch,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
      const log = execFileSync(
        gitPath,
        ["-C", join(scratch, "clone"), "log", "--format=%H %P|%an|%s"],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: scratch,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      )
        .toString()
        .trim()
        .split("\n");
      expect(log).toEqual([
        `${second.commitId} ${first.commitId}|Simon|Updated Plan`,
        `${first.commitId} |You|Created the page`,
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("returns the original publication for an exact retry and refuses a mismatched retry", async () => {
    const first = await published("# One\n", "req-1", null);
    const retry = await env.publisher().publish(input("# One\n", "req-1", null));
    expect(retry).toEqual({ status: "published", replayed: true, document: { ...first } });
    await expect(
      env.publisher().publish(input("# Different\n", "req-1", null)),
    ).rejects.toMatchObject({
      code: "idempotency.mismatch",
    });
    expect(await count("doc_commits")).toBe(1);
  });

  it("refuses a stale base as a conflict before any Git or upload work", async () => {
    const first = await published("# One\n", "req-1", null);
    await published("# One\n\nTwo\n", "req-2", first.commitId);
    const before = await objectKeys();
    const outcome = await env
      .publisher()
      .publish(input("# One\n\nOther\n", "req-3", first.commitId));
    expect(outcome).toMatchObject({ status: "conflict", currentGeneration: 2 });
    expect(await objectKeys()).toEqual(before);
  });

  it("yields exactly one publication for concurrent writes from the same base", async () => {
    const first = await published("# Base\n", "req-base", null);
    const outcomes = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        env.publisher().publish(input(`# Base\n\nWriter ${n}\n`, `req-${n}`, first.commitId)),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "published")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "conflict")).toHaveLength(3);
    expect(await count("doc_commits")).toBe(2);
    const repo = await env.db.first(
      sql(`SELECT generation FROM doc_repos WHERE task_id = :task`, { task }),
    );
    expect(repo?.generation).toBe(2);
  });

  it("creates no commit for unchanged content", async () => {
    const first = await published("# Same\n", "req-1", null);
    const outcome = await env.publisher().publish(input("# Same\n", "req-2", first.commitId));
    expect(outcome).toEqual({ status: "unchanged", commitId: first.commitId, generation: 1 });
    expect(await count("doc_commits")).toBe(1);
    const empty = await env.createTask(owner);
    expect(
      await env.publisher().publish({
        ...input("", "req-3", null),
        taskId: empty,
        context: env.context(owner, empty),
      }),
    ).toEqual({ status: "unchanged", commitId: null, generation: 0 });
  });

  it("refuses documents beyond the size limit and keeps the head", async () => {
    const first = await published("# Small\n", "req-1", null);
    const big = `# Big\n\n${"x".repeat(2_000)}\n`;
    await expect(
      env
        .publisher({ limits: { maxDocumentBytes: 1_000 } })
        .publish(input(big, "req-2", first.commitId)),
    ).rejects.toMatchObject({ code: "document.too_large" });
    await expect(
      env
        .publisher({ limits: { maxBundleBytes: 100 } })
        .publish(input("# Small\n\nmore\n", "req-3", first.commitId)),
    ).rejects.toMatchObject({ code: "document.history_too_large" });
    const repo = await env.db.first(
      sql(`SELECT head_commit_id FROM doc_repos WHERE task_id = :task`, { task }),
    );
    expect(repo?.head_commit_id).toBe(first.commitId);
    expect(await env.git.tempRoot.list()).toEqual([]);
  });

  it("refuses writes to archived tasks, including an archive that races the publication", async () => {
    const first = await published("# One\n", "req-1", null);
    const racing = env.publisher({
      hooks: {
        beforePublish: () => env.archiveTask(owner, task),
      },
    });
    await expect(
      racing.publish(input("# One\n\nTwo\n", "req-2", first.commitId)),
    ).rejects.toMatchObject({
      code: "task.archived",
    });
    const repo = await env.db.first(
      sql(`SELECT head_commit_id, generation FROM doc_repos WHERE task_id = :task`, { task }),
    );
    expect(repo).toEqual({ head_commit_id: first.commitId, generation: 1 });
    expect(await count("doc_commits")).toBe(1);
    await expect(
      env.publisher().publish(input("# Three\n", "req-3", first.commitId)),
    ).rejects.toMatchObject({
      code: "task.archived",
    });
  });

  it("refuses cross-user writes without touching the other user's document", async () => {
    await published("# Mine\n", "req-1", null);
    const intruder = await env.createUser();
    await expect(
      env.publisher().publish({
        ...input("# Theirs\n", "req-x", null),
        ownerId: intruder,
        context: env.context(intruder, task),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await count("doc_commits")).toBe(1);
  });

  it("publishes nothing when a caller guard refuses the write", async () => {
    const first = await published("# One\n", "req-1", null);
    const context = env.context(owner, task);
    await expect(
      env.publisher().publish({
        ...input("# One\n\nTwo\n", "req-2", first.commitId),
        context: {
          ...context,
          guards: [...context.guards, { sql: "EXISTS (SELECT 1 WHERE 0)", params: {} }],
        },
      }),
    ).rejects.toMatchObject({ code: "document.read_only" });
    expect(await count("doc_commits")).toBe(1);
    expect(await count("search_intents")).toBe(1);
  });
});

describe("crash points and uncertain outcomes (note 11)", () => {
  it("recovers from a crash before upload: nothing is written and a retry publishes", async () => {
    const first = await published("# One\n", "req-1", null);
    const before = await objectKeys();
    const crashing = env.publisher({
      hooks: {
        beforeUpload: () => {
          throw new Error("crash");
        },
      },
    });
    await expect(
      crashing.publish(input("# One\n\nTwo\n", "req-2", first.commitId)),
    ).rejects.toThrow("crash");
    expect(await objectKeys()).toEqual(before);
    expect(await env.git.tempRoot.list()).toEqual([]);
    const retried = await env.publisher().publish(input("# One\n\nTwo\n", "req-2", first.commitId));
    expect(retried).toMatchObject({ status: "published", replayed: false });
  });

  it("recovers from a crash after upload: the head is unchanged, a retry publishes, orphans stay for collection", async () => {
    const first = await published("# One\n", "req-1", null);
    const crashing = env.publisher({
      hooks: {
        afterUpload: () => {
          throw new Error("crash");
        },
      },
    });
    await expect(
      crashing.publish(input("# One\n\nTwo\n", "req-2", first.commitId)),
    ).rejects.toThrow("crash");
    const repo = await env.db.first(
      sql(`SELECT head_commit_id FROM doc_repos WHERE task_id = :task`, { task }),
    );
    expect(repo?.head_commit_id).toBe(first.commitId);
    const orphanCount = (await objectKeys()).length;
    expect(orphanCount).toBe(4);
    env.now += 1_000;
    const retried = await env.publisher().publish(input("# One\n\nTwo\n", "req-2", first.commitId));
    expect(retried).toMatchObject({ status: "published", replayed: false });
    expect(await count("doc_commits")).toBe(2);
  });

  it("recovers when the publication response is lost after it committed, without publishing twice", async () => {
    const first = await published("# One\n", "req-1", null);
    flaky.mode = "after";
    const outcome = await env.publisher().publish(input("# One\n\nTwo\n", "req-2", first.commitId));
    expect(outcome).toMatchObject({ status: "published", replayed: false });
    expect(await count("doc_commits")).toBe(2);
    const retry = await env.publisher().publish(input("# One\n\nTwo\n", "req-2", first.commitId));
    expect(retry).toMatchObject({ status: "published", replayed: true });
    expect(await count("doc_commits")).toBe(2);
  });

  it("recovers when the publication batch was lost before it ran by sending it once more", async () => {
    const first = await published("# One\n", "req-1", null);
    flaky.mode = "before";
    const outcome = await env.publisher().publish(input("# One\n\nTwo\n", "req-2", first.commitId));
    expect(outcome).toMatchObject({ status: "published", replayed: false });
    expect(await count("doc_commits")).toBe(2);
  });
});

describe("artifact integrity (§4.2, note 11 acceptance)", () => {
  it("fails without plaintext when an artifact was modified, swapped across tasks, or read with another key", async () => {
    const first = await published("# Secret plan\n\nconfidential marker text\n", "req-1", null);
    const repo = await env.db.first(
      sql(`SELECT bundle_key FROM doc_repos WHERE task_id = :task`, { task }),
    );
    const bundleKey = repo?.bundle_key as string;

    // Another account's key cannot open it.
    const other = await env.createUser();
    const otherKey = await env.accountKey(other);
    const stored = await env.objects.get(bundleKey);
    expect(() =>
      decryptObject(
        { ...otherKey, ownerId: owner },
        bundleEnvelopeContext(parseBundleObjectKey(bundleKey) as never),
        stored?.body as Uint8Array,
      ),
    ).toThrow();

    // A modified byte fails the next publication with a stable code and no plaintext.
    const tampered = Buffer.from(stored?.body as Uint8Array);
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0x01;
    await env.objects.delete(bundleKey);
    await env.objects.put({ key: bundleKey, body: tampered });
    const failure = await env
      .publisher()
      .publish(input("# Secret plan\n\nedited\n", "req-2", first.commitId))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocumentError);
    expect((failure as DocumentError).code).toBe("document.integrity_failed");
    expect(JSON.stringify(failure)).not.toContain("confidential");
    expect(String(failure)).not.toContain("confidential");
    expect(await env.git.tempRoot.list()).toEqual([]);

    // Task B's row pointing at task A's (valid) bundle fails the envelope binding.
    await env.objects.delete(bundleKey);
    await env.objects.put({ key: bundleKey, body: stored?.body as Uint8Array });
    const taskB = await env.createTask(owner);
    const publishedB = await env.publisher().publish({
      ...input("# B\n", "req-b", null),
      taskId: taskB,
      context: env.context(owner, taskB),
    });
    if (publishedB.status !== "published") throw new Error("expected B to publish");
    const rowB = await env.db.first(
      sql(`SELECT bundle_key, bundle_write_id, generation FROM doc_repos WHERE task_id = :task`, {
        task: taskB,
      }),
    );
    await env.objects.delete(rowB?.bundle_key as string);
    await env.objects.put({ key: rowB?.bundle_key as string, body: stored?.body as Uint8Array });
    await expect(
      env.publisher().publish({
        ...input("# B\n\nmore\n", "req-b2", publishedB.document.commitId),
        taskId: taskB,
        context: env.context(owner, taskB),
      }),
    ).rejects.toMatchObject({ code: "document.integrity_failed" });
    zeroize(otherKey.key);
  });

  it("restores as a new commit that preserves history", async () => {
    const first = await published("# Plan\n\nOriginal\n", "req-1", null);
    env.now += 1_000;
    const second = await published("# Plan\n\nChanged\n", "req-2", first.commitId);
    env.now += 1_000;
    const firstSnapshot = await env.artifacts.getSnapshot(await env.accountKey(owner), {
      ownerId: owner,
      taskId: task,
      commitId: first.commitId,
    });
    const restored = await published("ignored", "req-3", second.commitId, {
      edit: async ({ repository }) => {
        expect(await repository.isAncestor(first.commitId, second.commitId)).toBe(true);
        return {
          kind: "restore",
          markdown: firstSnapshot.markdown,
          restoredFrom: first.commitId,
          restoredFromCommittedAt: first.committedAt,
        };
      },
    });
    expect(restored).toMatchObject({
      kind: "restore",
      restoredFrom: first.commitId,
      generation: 3,
      parentCommitId: second.commitId,
    });
    const snapshot = await env.artifacts.getSnapshot(await env.accountKey(owner), {
      ownerId: owner,
      taskId: task,
      commitId: restored.commitId,
    });
    expect(snapshot.markdown).toBe("# Plan\n\nOriginal\n");
    expect(snapshot.subject).toMatch(/^Restored the version from /);
    expect(await count("doc_commits")).toBe(3);
  });
});
