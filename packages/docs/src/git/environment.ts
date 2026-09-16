import { accessSync, constants } from "node:fs";

/**
 * The isolated Git process environment (§9.1, research "Git plumbing"). Git runs with a fully
 * replaced environment (never merged with `process.env`): no system or global configuration, hooks
 * disabled, every transport refused, bare repositories only when named explicitly, no attributes,
 * signing, pagers, prompts, credential helpers, replace refs, automatic maintenance or reflogs.
 * Command-scope configuration (`GIT_CONFIG_COUNT`) counts as protected configuration, so
 * `safe.bareRepository` is honored.
 */
export const GIT_CONFIG_ENTRIES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["core.hooksPath", "/dev/null"],
  ["protocol.allow", "never"],
  ["safe.bareRepository", "explicit"],
  ["core.attributesFile", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.logAllRefUpdates", "false"],
  ["core.pager", "cat"],
  ["core.sshCommand", "/bin/false"],
  ["credential.helper", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["transfer.fsckObjects", "true"],
  ["init.defaultBranch", "main"],
  ["diff.external", ""],
]);

/** The fixed `PATH` for Git child processes. */
export const GIT_CHILD_PATH = "/usr/bin:/bin";

/** A commit identity with an explicit date, so a retried commit can produce the same id (§9.1). */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
  /** Whole seconds since the Unix epoch. */
  readonly epochSeconds: number;
}

export interface GitEnvironmentInput {
  /** The bare repository, passed as `GIT_DIR`; omitted for `git init`. */
  readonly gitDir?: string;
  /** A private, empty home directory inside the operation's temp directory. */
  readonly home: string;
  /** Author and committer for `commit-tree`. */
  readonly identity?: GitIdentity;
}

const identityText = /^[A-Za-z0-9 ._@+-]{1,64}$/;

/** Builds the complete environment of one Git invocation. */
export function gitEnvironment(input: GitEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {
    PATH: GIT_CHILD_PATH,
    HOME: input.home,
    XDG_CONFIG_HOME: input.home,
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ADVICE: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: String(GIT_CONFIG_ENTRIES.length),
  };
  GIT_CONFIG_ENTRIES.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (input.gitDir !== undefined) env.GIT_DIR = input.gitDir;
  if (input.identity) {
    const { name, email, epochSeconds } = input.identity;
    if (!identityText.test(name) || !identityText.test(email)) {
      throw new TypeError("Git identities are fixed service identities");
    }
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
      throw new TypeError("Git dates are whole epoch seconds");
    }
    const date = `@${epochSeconds} +0000`;
    env.GIT_AUTHOR_NAME = name;
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_NAME = name;
    env.GIT_COMMITTER_EMAIL = email;
    env.GIT_COMMITTER_DATE = date;
  }
  return env;
}

/** Candidate locations of the Git executable, checked in order when none is configured. */
export const GIT_EXECUTABLE_CANDIDATES = Object.freeze([
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
]);

/** The first executable Git among the candidates, or undefined. */
export function findGitExecutable(
  candidates: readonly string[] = GIT_EXECUTABLE_CANDIDATES,
): string | undefined {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}
