import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentMaintenance } from "@symplist/core/documents";
import { int, sql, uuidv7 } from "@symplist/db";
import type { GitRepository, GitService } from "@symplist/docs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_GIT } from "../src/modules/documents/documents.module.ts";
import { bootTestApp, type TestApp } from "./harness.ts";

const apps: TestApp[] = [];
const roots: string[] = [];
function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("API test Git workspace isolation", () => {
  it.each([false, true])(
    "captures the shared-root failure and protects the default isolated roots (shared=%s)",
    async (shared) => {
      // Even the negative control must never sweep a production/user-dev temp root.
      const root = mkdtempSync(join(tmpdir(), "symplist-git-isolation-"));
      roots.push(root);
      const options = shared ? { env: { GIT_TMP_DIR: join(root, "shared") } } : {};
      const publisher = await bootTestApp(options);
      apps.push(publisher);
      const sweeper = await bootTestApp(options);
      apps.push(sweeper);
      if (shared) {
        expect(publisher.config.GIT_TMP_DIR).toBe(join(root, "shared"));
        expect(sweeper.config.GIT_TMP_DIR).toBe(publisher.config.GIT_TMP_DIR);
      } else {
        // Fail safely before a future-clock sweep if isolation ever regresses.
        expect(publisher.config.GIT_TMP_DIR).toBe(join(publisher.dataDir, "git"));
        expect(sweeper.config.GIT_TMP_DIR).toBe(join(sweeper.dataDir, "git"));
        expect(sweeper.config.GIT_TMP_DIR).not.toBe(publisher.config.GIT_TMP_DIR);
      }
      const owner = await publisher.createSignedInUser();
      const task = uuidv7();
      await publisher.db.run(
        sql(
          `INSERT INTO tasks (id, owner_id, collection, position, source, write_id, title_enc, created_at, updated_at)
         VALUES (:id, :owner, 'now', 'a0', 'user', :write, 'sym1.1.x.y', :now, :now)`,
          { id: task, owner: owner.id, write: uuidv7(), now: int(publisher.clock.now()) },
        ),
      );
      const git = publisher.inject<GitService>(DOCUMENT_GIT);
      const original = git.withRepository.bind(git);
      const entered = barrier();
      const resume = barrier();
      const failures: unknown[] = [];
      vi.spyOn(git, "withRepository").mockImplementation(
        async <Result>(
          operation: (repository: GitRepository) => Promise<Result>,
        ): Promise<Result> => {
          try {
            return await original(async (repository) => {
              entered.resolve();
              await resume.promise;
              return operation(repository);
            });
          } catch (error) {
            failures.push(error);
            throw error;
          }
        },
      );
      const publication = publisher.post(`/v1/tasks/${task}/document/commits`, {
        session: owner.session,
        idempotencyKey: `git-isolation-${uuidv7()}`,
        body: { baseRevision: null, markdown: "# Isolated publication\nPreserve this page." },
      });
      try {
        await entered.promise;
        await sweeper.inject<DocumentMaintenance>(DocumentMaintenance).run({
          now: Date.now() + 2 * 24 * 60 * 60 * 1000,
        });
      } finally {
        resume.resolve();
      }
      const result = await publication;
      if (shared) {
        expect(result.status).toBe(500);
        expect(result.json()).toMatchObject({ error: { code: "internal" } });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ name: "GitError", code: "git.unavailable" });
      } else {
        expect(result.status, result.text).toBe(201);
        expect(failures).toEqual([]);
        const read = await publisher.get(`/v1/tasks/${task}/document`, { session: owner.session });
        expect(read.status, read.text).toBe(200);
        expect(read.text).toContain("Preserve this page.");
      }
    },
  );
});
