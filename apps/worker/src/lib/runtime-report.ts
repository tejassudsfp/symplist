import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

export interface RuntimeReport {
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  git: string | null;
  rssMb: number;
}

const execFileAsync: ExecFileFn = promisify(execFile);

/** Parses `git --version` output such as "git version 2.50.1 (Apple Git-155)". */
export function parseGitVersion(stdout: string): string | null {
  const match = /^git version (\S+)/.exec(stdout.trim());
  return match?.[1] ?? null;
}

/**
 * Reports the worker runtime. Git is invoked with a fixed argument array and a
 * minimal environment so ambient Git configuration cannot influence the check.
 */
export async function runtimeReport(exec: ExecFileFn = execFileAsync): Promise<RuntimeReport> {
  let git: string | null = null;
  try {
    const { stdout } = await exec("git", ["--version"], {
      timeout: 5_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
    });
    git = parseGitVersion(stdout);
  } catch {
    git = null;
  }

  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    git,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}
