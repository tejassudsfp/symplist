import { ConfigError, type ConfigIssue } from "./errors.ts";
import type { EnvRecord } from "./fields.ts";
import type { LiveTestFlags } from "./shared.ts";

/** Flags that enable live integration suites (§16.2, §17). */
export const liveTestFlagNames = Object.freeze([
  "LIVE_D1",
  "LIVE_R2",
  "LIVE_TRIGGER",
  "LIVE_COMPOSIO",
  "LIVE_OPENAI",
] as const satisfies readonly (keyof LiveTestFlags)[]);

/**
 * Reads the live-suite flags: `1` enables a suite, `0`, empty or absent disables it, and anything
 * else is an error. Live suites still skip with a visible reason when their credentials are absent.
 */
export function loadLiveTestFlags(env: EnvRecord): LiveTestFlags {
  const issues: ConfigIssue[] = [];
  const flags: Record<keyof LiveTestFlags, boolean> = {
    LIVE_D1: false,
    LIVE_R2: false,
    LIVE_TRIGGER: false,
    LIVE_COMPOSIO: false,
    LIVE_OPENAI: false,
  };
  for (const name of liveTestFlagNames) {
    const value = env[name];
    if (value === undefined || value === "" || value === "0") continue;
    if (value === "1") {
      flags[name] = true;
    } else {
      issues.push({
        variable: name,
        message: 'must be "1" to enable the live suite or "0" to skip it',
      });
    }
  }
  if (issues.length > 0) throw new ConfigError("tests", issues);
  return Object.freeze(flags);
}
