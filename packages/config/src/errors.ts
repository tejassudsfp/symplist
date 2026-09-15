/**
 * Configuration errors. Browser-safe: no `node:*` imports. Every message names the variable and the
 * rule it breaks, and never contains the variable's value (§16.1).
 */

/** The runtime whose environment is being validated. */
export type ConfigRuntime = "api" | "worker" | "web" | "tests";

/** One configuration problem. `message` never contains the variable's value. */
export interface ConfigIssue {
  readonly variable: string;
  readonly message: string;
}

/** The outcome of validating an environment without throwing. */
export type ConfigResult<Config> =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** Formats issues as a multi-line message for startup logs. */
export function formatConfigIssues(runtime: ConfigRuntime, issues: readonly ConfigIssue[]): string {
  const count = issues.length === 1 ? "1 problem" : `${issues.length} problems`;
  return [
    `Invalid ${runtime} configuration (${count}):`,
    ...issues.map(({ variable, message }) => `- ${variable}: ${message}`),
  ].join("\n");
}

/** Thrown by the `load*Config` functions when the environment is invalid. */
export class ConfigError extends Error {
  readonly runtime: ConfigRuntime;
  readonly issues: readonly ConfigIssue[];

  constructor(runtime: ConfigRuntime, issues: readonly ConfigIssue[]) {
    super(formatConfigIssues(runtime, issues));
    this.name = "ConfigError";
    this.runtime = runtime;
    this.issues = Object.freeze([...issues]);
  }
}

/** Sorts issues by variable and removes exact duplicates, so reports are stable. */
export function normalizeIssues(issues: Iterable<ConfigIssue>): ConfigIssue[] {
  const seen = new Set<string>();
  const unique: ConfigIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.variable}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ variable: issue.variable, message: issue.message });
  }
  return unique.sort(
    (a, b) => compareText(a.variable, b.variable) || compareText(a.message, b.message),
  );
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Returns the config or throws a `ConfigError` with every issue. */
export function unwrapConfig<Config>(runtime: ConfigRuntime, result: ConfigResult<Config>): Config {
  if (!result.ok) throw new ConfigError(runtime, result.issues);
  return result.config;
}
