import { execFile } from "node:child_process";
import { GitError } from "./errors.ts";

/** Per-command bounds (§9.1). */
export interface GitCommandLimits {
  /** Wall-clock limit; the process is killed with SIGKILL when it is exceeded. */
  readonly timeoutMs: number;
  /** Largest stdout accepted; the process is killed when it writes more. */
  readonly maxOutputBytes: number;
}

export interface GitCommand {
  /** Fixed argument array; never passed through a shell. */
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Bytes written to stdin, which is then closed. */
  readonly input?: Uint8Array;
  readonly limits: GitCommandLimits;
  /** Exit statuses treated as success (defaults to `[0]`). */
  readonly okExitCodes?: readonly number[];
}

export interface GitCommandResult {
  readonly stdout: Buffer;
  readonly exitCode: number;
}

/** Runs one Git command. Replaceable in tests to inject failures. */
export type GitCommandRunner = (gitPath: string, command: GitCommand) => Promise<GitCommandResult>;

const argumentPattern = /^[^\0\n\r]*$/;

/**
 * Runs Git with `execFile` (no shell), a fixed argument array and exactly the given environment, with
 * a time limit and an output limit. Failures become {@link GitError}s that keep only the subcommand
 * and exit status; stderr is discarded (it can quote paths and object names).
 */
export const execGit: GitCommandRunner = (gitPath, command) => {
  for (const argument of command.args) {
    if (typeof argument !== "string" || !argumentPattern.test(argument)) {
      return Promise.reject(new GitError("git.failed", { subcommand: "invalid_argument" }));
    }
  }
  const subcommand = command.args[0] ?? "";
  const ok = command.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        gitPath,
        [...command.args],
        {
          cwd: command.cwd,
          env: { ...command.env },
          encoding: "buffer",
          maxBuffer: command.limits.maxOutputBytes,
          timeout: command.limits.timeoutMs,
          killSignal: "SIGKILL",
          windowsHide: true,
          shell: false,
        },
        (error, stdout, _stderr) => {
          if (!error) {
            resolve({ stdout: stdout as Buffer, exitCode: 0 });
            return;
          }
          const failure = error as NodeJS.ErrnoException & {
            code?: string | number;
            killed?: boolean;
            signal?: string | null;
          };
          if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(new GitError("git.output_too_large", { subcommand }));
            return;
          }
          if (failure.killed || failure.signal === "SIGKILL") {
            reject(new GitError("git.timeout", { subcommand }));
            return;
          }
          if (typeof failure.code === "number") {
            if (ok.includes(failure.code)) {
              resolve({ stdout: stdout as Buffer, exitCode: failure.code });
              return;
            }
            reject(new GitError("git.failed", { subcommand, exitCode: failure.code }));
            return;
          }
          reject(new GitError("git.unavailable", { subcommand }));
        },
      );
    } catch {
      reject(new GitError("git.unavailable", { subcommand }));
      return;
    }
    child.stdin?.on("error", () => {
      // The process may exit before reading stdin (for example on a usage error); its exit status
      // decides the outcome.
    });
    child.stdin?.end(command.input ? Buffer.from(command.input) : undefined);
  });
};
