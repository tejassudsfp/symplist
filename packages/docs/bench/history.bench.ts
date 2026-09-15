import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { zeroize } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { expect, it } from "vitest";
import { CiphertextCache, DocumentArtifacts } from "../src/artifacts/store.ts";
import { findGitExecutable } from "../src/git/environment.ts";
import { contentDigest, DocumentPublisher } from "../src/publication/publisher.ts";
import { DocumentHistoryReader } from "../src/publication/reader.ts";
import { repoFromRow, selectRepoStatement } from "../src/publication/records.ts";
import { buildSectionIndex } from "../src/sections/section-index.ts";
import {
  createDocsTestEnvironment,
  type DocsTestEnvironment,
} from "../src/test-support/environment.ts";

/**
 * Cold and warm latency and bundle sizes for representative histories (note 11 "Benchmark
 * representative histories before choosing limits"). Everything runs locally: real Git, the
 * `node:sqlite` D1 stand-in and the filesystem object store, so the numbers measure Git, encryption
 * and parsing, not network round trips to D1 or R2. "Cold" reads artifacts with an empty ciphertext
 * cache; "warm" reuses the cache a previous operation filled. Each Git operation always starts from a
 * fresh private repository (§9.1).
 */

interface Scenario {
  readonly name: string;
  readonly documentBytes: number;
  readonly commits: number;
}

const scenarios: readonly Scenario[] = [
  { name: "small page, short history", documentBytes: 2_000, commits: 25 },
  { name: "small page, long history", documentBytes: 2_000, commits: 200 },
  { name: "medium page", documentBytes: 50_000, commits: 50 },
  { name: "large page", documentBytes: 500_000, commits: 20 },
];

const vocabulary =
  "portfolio outline budget project draft review export images weather station library archive notes typography experiments about page contact volunteers garden timeline goals ship check link photo".split(
    " ",
  );

/** Deterministic prose of about `bytes`, one section per kilobyte, with section `revision` edited. */
function document(bytes: number, revision: number): string {
  const sections = Math.max(2, Math.round(bytes / 1_000));
  let seed = 7;
  const word = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return vocabulary[seed % vocabulary.length] as string;
  };
  const lines: string[] = [];
  for (let section = 0; section < sections; section += 1) {
    lines.push(`## Section ${section}`, "");
    const words = Array.from({ length: 150 }, word).join(" ");
    const touched = revision % sections === section ? ` Revised in revision ${revision}.` : "";
    lines.push(`${words}.${touched}`, "");
  }
  return `${lines.join("\n")}\n`;
}

async function time<T>(
  work: () => Promise<T>,
): Promise<{ readonly ms: number; readonly value: T }> {
  const started = performance.now();
  const value = await work();
  return { ms: Math.round((performance.now() - started) * 10) / 10, value };
}

async function measure(env: DocsTestEnvironment, scenario: Scenario) {
  const owner = await env.createUser();
  const task = await env.createTask(owner);
  const publisher = (artifacts: DocumentArtifacts) =>
    new DocumentPublisher({ db: env.db, git: env.git, artifacts });
  const coldArtifacts = () =>
    new DocumentArtifacts({ objects: env.objects, cache: new CiphertextCache(0) });
  let base: string | null = null;
  const publish = async (artifacts: DocumentArtifacts, revision: number) => {
    const markdown = document(scenario.documentBytes, revision);
    const outcome = await publisher(artifacts).publish({
      ownerId: owner,
      taskId: task,
      scope: "bench",
      requestId: `bench-${revision}`,
      fingerprint: { content: contentDigest(markdown), revision },
      expectedBase: base,
      author: revision % 3 === 0 ? "simon" : "user",
      now: env.now,
      context: env.context(owner, task),
      edit: () => ({ kind: "edit", markdown }),
    });
    env.now += 1_000;
    if (outcome.status !== "published") throw new Error(`unexpected ${outcome.status}`);
    base = outcome.document.commitId;
  };

  const building = await time(async () => {
    for (let revision = 0; revision < scenario.commits; revision += 1) {
      await publish(coldArtifacts(), revision);
    }
  });
  const warmArtifacts = new DocumentArtifacts({ objects: env.objects });
  const coldPublish = await time(() => publish(coldArtifacts(), scenario.commits));
  const primed = await time(() => publish(warmArtifacts, scenario.commits + 1));
  const warmPublish = await time(() => publish(warmArtifacts, scenario.commits + 2));

  const row = await env.db.first(selectRepoStatement(owner, task));
  if (!row) throw new Error("missing head");
  const repo = repoFromRow(row);
  const first = await env.db.first(
    sql(`SELECT commit_id FROM doc_commits WHERE task_id = :task AND generation = 1`, { task }),
  );
  const accountKey = await env.accountKey(owner);
  try {
    const coldReader = new DocumentHistoryReader({ git: env.git, artifacts: coldArtifacts() });
    const warmReader = new DocumentHistoryReader({ git: env.git, artifacts: warmArtifacts });
    const historyCold = await time(() =>
      coldReader.history(repo, accountKey, { pinnedHead: repo.headCommitId, skip: 0, limit: 20 }),
    );
    await warmReader.history(repo, accountKey, {
      pinnedHead: repo.headCommitId,
      skip: 0,
      limit: 20,
    });
    const historyWarm = await time(() =>
      warmReader.history(repo, accountKey, { pinnedHead: repo.headCommitId, skip: 0, limit: 20 }),
    );
    const diffWarm = await time(() =>
      warmReader.diff(repo, accountKey, {
        base: first?.commit_id as string,
        target: repo.headCommitId,
      }),
    );
    const snapshotRef = { ownerId: owner, taskId: task, commitId: repo.headCommitId };
    const outlineCold = await time(() => coldArtifacts().getSnapshot(accountKey, snapshotRef));
    await warmArtifacts.getSnapshot(accountKey, snapshotRef);
    const outlineWarm = await time(() => warmArtifacts.getSnapshot(accountKey, snapshotRef));
    const indexOnly = await time(async () =>
      buildSectionIndex(document(scenario.documentBytes, 1), "a".repeat(40)),
    );
    const encrypted = await env.objects.head(repo.bundleKey);
    const snapshot = await env.objects.head(repo.snapshotKey);
    expect(historyWarm.value).toHaveLength(Math.min(20, repo.generation));
    return {
      scenario: scenario.name,
      documentBytes: repo.documentBytes,
      commits: repo.generation,
      bundleBytes: repo.bundleBytes,
      encryptedBundleBytes: encrypted?.size ?? 0,
      snapshotBytes: snapshot?.size ?? 0,
      avgPublishMs: Math.round((building.ms / scenario.commits) * 10) / 10,
      coldPublishMs: coldPublish.ms,
      warmPublishMs: Math.min(primed.ms, warmPublish.ms),
      historyColdMs: historyCold.ms,
      historyWarmMs: historyWarm.ms,
      diffWarmMs: diffWarm.ms,
      snapshotReadColdMs: outlineCold.ms,
      snapshotReadWarmMs: outlineWarm.ms,
      indexBuildMs: indexOnly.ms,
    };
  } finally {
    zeroize(accountKey.key);
  }
}

it("measures publication, history, diff and snapshot latency and bundle sizes", async () => {
  const gitPath = findGitExecutable();
  if (!gitPath) throw new Error("Git is required for the benchmark");
  const gitVersion = execFileSync(gitPath, ["--version"], { env: { PATH: "/usr/bin:/bin" } })
    .toString()
    .trim();
  const results = [];
  for (const scenario of scenarios) {
    const env = await createDocsTestEnvironment();
    try {
      results.push(await measure(env, scenario));
    } finally {
      await env.close();
    }
  }
  const columns = Object.keys(results[0] ?? {});
  const table = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...results.map(
      (result) =>
        `| ${columns.map((column) => String(result[column as keyof typeof result])).join(" | ")} |`,
    ),
  ].join("\n");
  console.log(
    `\n${gitVersion}, Node ${process.version}, ${process.platform}/${process.arch}\n${table}\n`,
  );
  expect(results).toHaveLength(scenarios.length);
});
