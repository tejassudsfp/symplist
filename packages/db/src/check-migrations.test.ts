import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/check-migrations.mjs", import.meta.url));
const gitEnv = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): {
  dir: string;
  git: (...args: string[]) => string;
  write: (name: string, text: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "symplist-check-migrations-"));
  cleanups.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  mkdirSync(join(dir, "packages/db/migrations"), { recursive: true });
  const write = (name: string, text: string) =>
    writeFileSync(join(dir, "packages/db/migrations", name), text);
  write("0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY) STRICT;\n");
  write("README.md", "Migrations\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "--quiet", "-b", "feature");
  return { dir, git, write };
}

function check(dir: string, ...args: string[]) {
  return checkWithEnv(dir, {}, ...args);
}

function checkWithEnv(dir: string, env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    env: { ...gitEnv, ...env },
    encoding: "utf8",
  });
}

describe("scripts/check-migrations.mjs", () => {
  it("passes when merged files are unchanged and new files are added", () => {
    const { dir, write, git } = repo();
    write("0100_invites.sql", "CREATE TABLE beta_invites (id TEXT PRIMARY KEY) STRICT;\n");
    write("README.md", "Migrations, updated\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "feature");
    const result = check(dir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 merged migration file(s) unchanged against origin/main");
  });

  it("fails when a merged migration file is modified, committed or not", () => {
    const { dir, write, git } = repo();
    write("0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT) STRICT;\n");
    let result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("modified: packages/db/migrations/0001_users.sql");
    git("commit", "--quiet", "-am", "edit merged migration");
    result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("modified: packages/db/migrations/0001_users.sql");
  });

  it("fails when a merged migration file is deleted or renamed", () => {
    const { dir, git } = repo();
    git("mv", "packages/db/migrations/0001_users.sql", "packages/db/migrations/0002_users.sql");
    git("commit", "--quiet", "-m", "rename");
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deleted: packages/db/migrations/0001_users.sql");
  });

  it("does not blame a branch that is merely behind main", () => {
    const { dir, git } = repo();
    git("checkout", "--quiet", "main");
    writeFileSync(
      join(dir, "packages/db/migrations/0200_workspace.sql"),
      "CREATE TABLE extra (id TEXT PRIMARY KEY) STRICT;\n",
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "newer main");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "--quiet", "feature");
    const result = check(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("branch is behind");
    unlinkSync(join(dir, "packages/db/migrations/0001_users.sql"));
    expect(check(dir).status).toBe(1);
  });

  it("catches a merged file edited directly on main through the previous main commit", () => {
    const { dir, git, write } = repo();
    git("checkout", "--quiet", "main");
    const before = git("rev-parse", "HEAD").trim();
    write("0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT) STRICT;\n");
    git("commit", "--quiet", "-am", "edit merged migration on main");
    // After a push to main, the fetched origin/main is the pushed commit itself.
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(check(dir).status).toBe(0);

    const result = checkWithEnv(dir, { MIGRATIONS_BASE_REF: before });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("modified: packages/db/migrations/0001_users.sql");
    // GitHub's all-zero `before` and an empty value fall back to origin/main.
    expect(checkWithEnv(dir, { MIGRATIONS_BASE_REF: "0".repeat(40) }).status).toBe(0);
    expect(checkWithEnv(dir, { MIGRATIONS_BASE_REF: "" }).stdout).toContain("against origin/main");
  });

  it("fails clearly when the base ref is missing and honors --base", () => {
    const { dir, git } = repo();
    git("update-ref", "-d", "refs/remotes/origin/main");
    const missing = check(dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("base ref origin/main not found");
    expect(check(dir, "--base", "main").status).toBe(0);
  });
});
