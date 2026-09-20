// Fails when a migration file already merged to main was modified or deleted (architecture §3.4):
// a merged migration never changes. New files are allowed.
//
// Usage: node scripts/check-migrations.mjs [--base <ref>] [--fetch]
//   --base   the merged ref to compare against (default: MIGRATIONS_BASE_REF, else origin/main).
//            On a push to main, CI passes the previous main commit, because origin/main is then
//            HEAD itself and a direct edit of a merged file would otherwise compare equal.
//   --fetch  fetch main from origin first, unshallowing when needed so the merge base resolves;
//            GITHUB_TOKEN, when set, authenticates the fetch through git's environment config.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const MIGRATIONS_DIR = "packages/db/migrations";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    fetch: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

function tryGit(args, options) {
  try {
    return git(args, options).trim();
  } catch {
    return undefined;
  }
}

function fail(message) {
  console.error(`check-migrations: ${message}`);
  process.exit(1);
}

const root = tryGit(["rev-parse", "--show-toplevel"]);
if (!root) fail("not inside a git repository");

/** An unset, empty or all-zero ref (GitHub's `before` for a newly created branch) means "no base". */
function usableRef(value) {
  const trimmed = value?.trim();
  return trimmed && !/^0+$/.test(trimmed) ? trimmed : undefined;
}

const base = usableRef(values.base) ?? usableRef(process.env.MIGRATIONS_BASE_REF) ?? "origin/main";

if (values.fetch) {
  const env = { ...process.env };
  if (process.env.GITHUB_TOKEN) {
    // Passed through git's environment config so the token never appears in argv.
    const basic = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  const shallow = tryGit(["rev-parse", "--is-shallow-repository"], { cwd: root }) === "true";
  const args = ["fetch", "--no-tags", "--quiet"];
  if (shallow) args.push("--unshallow");
  args.push("origin", "+refs/heads/main:refs/remotes/origin/main");
  try {
    git(args, { cwd: root, env });
  } catch {
    fail("could not fetch main from origin");
  }
}

if (!tryGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd: root })) {
  fail(`base ref ${base} not found; fetch it first (for example with --fetch)`);
}

/** Blob ids of migration files at a commit, keyed by repository path. */
function blobsAt(ref) {
  const output = tryGit(["ls-tree", "-r", ref, "--", `${MIGRATIONS_DIR}/`], { cwd: root }) ?? "";
  const blobs = new Map();
  for (const line of output.split("\n")) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match?.[2]?.endsWith(".sql")) blobs.set(match[2], match[1]);
  }
  return blobs;
}

const merged = blobsAt(base);
const mergeBase = tryGit(["merge-base", "HEAD", base], { cwd: root });
const atMergeBase = mergeBase ? blobsAt(mergeBase) : undefined;

const present = [...merged.keys()].filter((path) => existsSync(join(root, path)));
const hashes = new Map();
if (present.length > 0) {
  // Hashes the working tree with the repository's filters, so line-ending normalization matches.
  const output = git(["hash-object", "--stdin-paths"], {
    cwd: root,
    input: `${present.join("\n")}\n`,
  });
  const lines = output.trim().split("\n");
  for (const [index, hash] of lines.entries()) hashes.set(present[index], hash);
}

const violations = [];
for (const [path, blob] of merged) {
  if (hashes.has(path)) {
    if (hashes.get(path) !== blob) violations.push(`modified: ${path}`);
    continue;
  }
  // Missing here: a deletion when this branch already had the file, otherwise the branch is behind.
  if (!atMergeBase || atMergeBase.has(path)) {
    violations.push(
      `deleted: ${path}${atMergeBase ? "" : " (no merge base; fetch full history to tell)"}`,
    );
  } else {
    console.log(
      `check-migrations: ${path} is on ${base} but not in this checkout (branch is behind)`,
    );
  }
}

if (violations.length > 0) {
  console.error(`check-migrations: migration files merged to ${base} must never change:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log(`check-migrations: ${merged.size} merged migration file(s) unchanged against ${base}`);
