import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hunkTouches, pageDiffHunks, parseUnifiedDiff } from "./diff.ts";
import { GIT_CONFIG_ENTRIES, gitEnvironment } from "./environment.ts";
import { GitError } from "./errors.ts";
import type { GitRepository } from "./repository.ts";
import { execGit, type GitCommandRunner } from "./runner.ts";
import { GitService } from "./service.ts";
import { GIT_WORKSPACE_PREFIX } from "./workspace.ts";

let dir: string;
let git: GitService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symplist-git-test-"));
  git = new GitService({ tempDir: join(dir, "tmp") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const you = (epochSeconds: number) => ({
  name: "You",
  email: "you@users.symplist.invalid",
  epochSeconds,
});

async function commitDocument(
  repository: GitRepository,
  text: string,
  parent: string | null,
  epochSeconds: number,
  message = "Update\n",
): Promise<string> {
  const blob = await repository.writeBlob(Buffer.from(text, "utf8"));
  const tree = await repository.writeDocumentTree(blob);
  const commit = await repository.commitTree({
    tree,
    parents: parent ? [parent] : [],
    message,
    identity: you(epochSeconds),
  });
  await repository.updateMain(commit, parent);
  return commit;
}

describe("isolated Git environment (§9.1)", () => {
  it("replaces the environment entirely and carries the required isolation settings", () => {
    process.env.GIT_DIR = "/tmp/should-not-leak";
    process.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath=/tmp/evil'";
    try {
      const env = gitEnvironment({ gitDir: "/x/repo.git", home: "/x/home" });
      expect(env.GIT_DIR).toBe("/x/repo.git");
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env).toMatchObject({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        PATH: "/usr/bin:/bin",
        HOME: "/x/home",
      });
      const config = new Map(GIT_CONFIG_ENTRIES);
      expect(config.get("core.hooksPath")).toBe("/dev/null");
      expect(config.get("protocol.allow")).toBe("never");
      expect(config.get("safe.bareRepository")).toBe("explicit");
      expect(Number(env.GIT_CONFIG_COUNT)).toBe(GIT_CONFIG_ENTRIES.length);
      for (const [index, [key, value]] of GIT_CONFIG_ENTRIES.entries()) {
        expect(env[`GIT_CONFIG_KEY_${index}`]).toBe(key);
        expect(env[`GIT_CONFIG_VALUE_${index}`]).toBe(value);
      }
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_CONFIG_PARAMETERS;
    }
    expect(() =>
      gitEnvironment({ home: "/h", identity: { name: "a\nb", email: "x", epochSeconds: 1 } }),
    ).toThrow(TypeError);
  });

  it("never runs repository hooks, external diff drivers or transports", async () => {
    const marker = join(dir, "hook-ran");
    await git.withRepository(async (repository) => {
      const hooks = join(repository.workspace.repoDir, "hooks");
      mkdirSync(hooks, { recursive: true });
      for (const hook of ["reference-transaction", "post-commit", "pre-commit"]) {
        writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`);
        chmodSync(join(hooks, hook), 0o755);
      }
      writeFileSync(
        join(repository.workspace.repoDir, "config"),
        "[core]\n\tbare = true\n\thooksPath = hooks\n[diff]\n\texternal = /bin/false\n",
      );
      const first = await commitDocument(repository, "# One\n", null, 1_700_000_000);
      const second = await commitDocument(repository, "# Two\n", first, 1_700_000_060);
      expect(await repository.diff(first, second)).toContain("+# Two");
      const bundle = await repository.createBundle("probe.bundle", 1_000_000);
      writeFileSync(join(dir, "probe.bundle"), bundle);
      const fetch = execGit(git.available ? "/usr/bin/git" : "", {
        args: ["fetch", join(dir, "probe.bundle"), "refs/heads/main:refs/heads/copy"],
        cwd: repository.workspace.dir,
        env: gitEnvironment({
          gitDir: repository.workspace.repoDir,
          home: repository.workspace.homeDir,
        }),
        limits: { timeoutMs: 10_000, maxOutputBytes: 64_000 },
      });
      await expect(fetch).rejects.toMatchObject({ code: "git.failed" });
    });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("plumbing commits and bundles", () => {
  it("creates deterministic commits with explicit parents, identities and dates", async () => {
    const ids = await Promise.all(
      [0, 1].map(() =>
        git.withRepository(async (repository) => {
          const first = await commitDocument(repository, "# Plan\n", null, 1_700_000_000);
          const second = await commitDocument(repository, "# Plan\n\nMore\n", first, 1_700_000_100);
          return [first, second];
        }),
      ),
    );
    expect(ids[0]).toEqual(ids[1]);
  });

  it("refuses a stale compare-and-swap and keeps the head", async () => {
    await git.withRepository(async (repository) => {
      const first = await commitDocument(repository, "a\n", null, 1);
      const second = await commitDocument(repository, "b\n", first, 2);
      const blob = await repository.writeBlob(Buffer.from("c\n"));
      const tree = await repository.writeDocumentTree(blob);
      const stale = await repository.commitTree({
        tree,
        parents: [first],
        message: "x\n",
        identity: you(3),
      });
      await expect(repository.updateMain(stale, first)).rejects.toBeInstanceOf(GitError);
      expect(await repository.readMain()).toBe(second);
      await expect(repository.updateMain(stale, null)).rejects.toBeInstanceOf(GitError);
    });
  });

  it("round-trips a self-contained bundle into a fresh repository with history intact", async () => {
    const created = await git.withRepository(async (repository) => {
      const first = await commitDocument(repository, "# One\n", null, 10, "Created the page\n");
      const second = await commitDocument(repository, "# One\n\nTwo\n", first, 20, "Updated One\n");
      await repository.fsck();
      return { bundle: await repository.createBundle("out.bundle", 1_000_000), first, second };
    });
    await git.withRepository(async (repository) => {
      const refs = await repository.unbundle("in.bundle", created.bundle);
      expect([...refs]).toEqual([["refs/heads/main", created.second]]);
      await repository.updateMain(created.second, null);
      await repository.fsck();
      expect(await repository.commitCount(created.second)).toBe(2);
      expect((await repository.readDocument(created.second)).toString()).toBe("# One\n\nTwo\n");
      expect(await repository.isAncestor(created.first, created.second)).toBe(true);
      expect(await repository.isAncestor(created.second, created.first)).toBe(false);
      expect(await repository.hasCommit(created.first)).toBe(true);
      expect(await repository.hasCommit("0".repeat(40))).toBe(false);
      const log = await repository.log(created.second, 0, 10);
      expect(log.map((entry) => [entry.commitId, entry.message, entry.authorName])).toEqual([
        [created.second, "Updated One", "You"],
        [created.first, "Created the page", "You"],
      ]);
      expect(log[0]?.parents).toEqual([created.first]);
      expect(log[0]?.authoredAt).toBe(20);
      expect((await repository.log(created.second, 1, 10)).map((entry) => entry.commitId)).toEqual([
        created.first,
      ]);
    });
  });

  it("rejects corrupted and oversized bundles", async () => {
    const bundle = await git.withRepository(async (repository) => {
      await commitDocument(repository, "# Body with enough text to corrupt\n".repeat(20), null, 1);
      await expect(repository.createBundle("small.bundle", 10)).rejects.toMatchObject({
        code: "git.limit_exceeded",
      });
      return repository.createBundle("ok.bundle", 1_000_000);
    });
    const corrupted = Buffer.from(bundle);
    const at = corrupted.length - 30;
    corrupted[at] = (corrupted[at] ?? 0) ^ 0xff;
    await git.withRepository(async (repository) => {
      await expect(repository.unbundle("bad.bundle", corrupted)).rejects.toBeInstanceOf(GitError);
    });
    await git.withRepository(async (repository) => {
      await expect(
        repository.unbundle("junk.bundle", Buffer.from("not a bundle")),
      ).rejects.toBeInstanceOf(GitError);
    });
  });

  it("refuses blobs beyond the document limit before running Git", async () => {
    const small = new GitService({ tempDir: join(dir, "tmp2"), limits: { maxBlobBytes: 8 } });
    await small.withRepository(async (repository) => {
      await expect(repository.writeBlob(Buffer.from("123456789"))).rejects.toMatchObject({
        code: "git.limit_exceeded",
      });
    });
  });
});

describe("temporary plaintext and bounds (§9.1)", () => {
  it("removes the operation directory after success and after failure", async () => {
    await git.withRepository(async (repository) => {
      await commitDocument(repository, "secret plan\n", null, 1);
      expect(await git.tempRoot.list()).toHaveLength(1);
    });
    expect(await git.tempRoot.list()).toEqual([]);
    await expect(
      git.withRepository(async (repository) => {
        await commitDocument(repository, "secret plan\n", null, 1);
        throw new Error("crash in the middle");
      }),
    ).rejects.toThrow("crash in the middle");
    expect(await git.tempRoot.list()).toEqual([]);
  });

  it("sweeps directories a crashed process left behind, and only those", async () => {
    await git.tempRoot.ensure();
    const stale = join(git.tempRoot.root, `${GIT_WORKSPACE_PREFIX}crashed`);
    const fresh = join(git.tempRoot.root, `${GIT_WORKSPACE_PREFIX}running`);
    const unrelated = join(git.tempRoot.root, "other");
    for (const path of [stale, fresh, unrelated])
      mkdirSync(join(path, "repo.git"), { recursive: true });
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);
    utimesSync(unrelated, old, old);
    expect(await git.sweepStaleWorkspaces()).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("bounds concurrency and refuses work beyond the queue", async () => {
    const bounded = new GitService({
      tempDir: join(dir, "tmp3"),
      limits: { maxConcurrent: 1, maxQueued: 1 },
    });
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const holding = bounded.withRepository(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          started();
        }),
    );
    await running;
    const queued = bounded.withRepository(async () => "queued");
    await expect(bounded.withRepository(async () => "refused")).rejects.toMatchObject({
      code: "git.busy",
    });
    expect(bounded.running).toBe(1);
    release();
    await holding;
    await expect(queued).resolves.toBe("queued");
  });

  it("kills commands past their time or output limit and reports a missing executable", async () => {
    const base = { cwd: dir, env: { PATH: "/usr/bin:/bin" } };
    await expect(
      execGit("/bin/sleep", {
        ...base,
        args: ["5"],
        limits: { timeoutMs: 100, maxOutputBytes: 1000 },
      }),
    ).rejects.toMatchObject({ code: "git.timeout" });
    await expect(
      execGit("/bin/cat", {
        ...base,
        args: [],
        input: Buffer.alloc(200_000, 97),
        limits: { timeoutMs: 5_000, maxOutputBytes: 1_000 },
      }),
    ).rejects.toMatchObject({ code: "git.output_too_large" });
    await expect(
      execGit(join(dir, "missing-git"), {
        ...base,
        args: ["status"],
        limits: { timeoutMs: 1000, maxOutputBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: "git.unavailable" });
    await expect(
      execGit("/bin/echo", {
        ...base,
        args: ["a\nb"],
        limits: { timeoutMs: 1000, maxOutputBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: "git.failed" });
    const missing = new GitService({
      tempDir: join(dir, "tmp4"),
      gitPath: join(dir, "missing-git"),
    });
    await expect(missing.withRepository(async () => 1)).rejects.toMatchObject({
      code: "git.unavailable",
    });
  });

  it("keeps stderr, paths and arguments out of Git errors", async () => {
    const captured: Error[] = [];
    const runner: GitCommandRunner = async (path, command) => {
      try {
        return await execGit(path, command);
      } catch (error) {
        captured.push(error as Error);
        throw error;
      }
    };
    const service = new GitService({ tempDir: join(dir, "tmp5"), runner });
    await service.withRepository(async (repository) => {
      await expect(repository.readDocument("f".repeat(40))).rejects.toBeInstanceOf(GitError);
    });
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).not.toContain(dir);
    expect(captured[0]?.message).toBe("git.failed");
  });
});

describe("unified diff parsing", () => {
  const diff = [
    "diff --git a/document.md b/document.md",
    "index 1..2 100644",
    "--- a/document.md",
    "+++ b/document.md",
    "@@ -1,3 +1,3 @@",
    " # Plan",
    "-old line",
    "+new line",
    " tail",
    "@@ -10 +10,2 @@",
    " ten",
    "+eleven",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  it("labels added and removed lines with their line numbers", () => {
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines).toEqual([
      { kind: "context", text: "# Plan", baseLine: 1, targetLine: 1 },
      { kind: "removed", text: "old line", baseLine: 2, targetLine: null },
      { kind: "added", text: "new line", baseLine: null, targetLine: 2 },
      { kind: "context", text: "tail", baseLine: 3, targetLine: 3 },
    ]);
    expect(hunks[1]).toMatchObject({
      baseStart: 10,
      baseLines: 1,
      targetStart: 10,
      targetLines: 2,
    });
    expect(hunkTouches(hunks[1] as never, [{ side: "target", from: 11, to: 11 }])).toBe(true);
    expect(hunkTouches(hunks[0] as never, [{ side: "target", from: 11, to: 20 }])).toBe(false);
  });

  it("pages hunks within a byte budget", () => {
    const hunks = parseUnifiedDiff(diff);
    const first = pageDiffHunks(hunks, 0, 20);
    expect(first.hunks).toHaveLength(1);
    expect(first.hunks[0]?.truncated).toBe(true);
    expect(first.nextOffset).toBe(1);
    const all = pageDiffHunks(hunks, 0, 10_000);
    expect(all.hunks.map((hunk) => hunk.truncated)).toEqual([false, false]);
    expect(all.nextOffset).toBeNull();
  });
});
