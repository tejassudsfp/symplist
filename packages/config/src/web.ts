import * as z from "zod";
import { type ConfigIssue, type ConfigResult, normalizeIssues, unwrapConfig } from "./errors.ts";
import {
  type EnvRecord,
  envRecordSchema,
  fallbackIssueMessage,
  isLoopbackHostname,
  isSecureOrigin,
  issuesFromZod,
  optionalOriginVariable,
  originVariable,
  parseOrigin,
  posthogProjectKeyVariable,
  presentVariables,
} from "./fields.ts";
import { isSecretVariable } from "./secrets.ts";

/**
 * Public web configuration (§16.2). Browser-safe: this entry point never imports `node:*` and only
 * describes values that are inlined into the client bundle at build time.
 */
export interface WebPublicConfig {
  NEXT_PUBLIC_API_URL: string;
  NEXT_PUBLIC_WS_URL: string;
  NEXT_PUBLIC_POSTHOG_KEY?: string;
  NEXT_PUBLIC_POSTHOG_HOST?: string;
}

/** The only `NEXT_PUBLIC_*` variables the web app may define. */
export const webPublicVariableNames = Object.freeze([
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_WS_URL",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_POSTHOG_HOST",
] as const);

/** Every variable the web app reads, including the Vercel build setting (§1). */
export const webVariableNames: readonly string[] = Object.freeze([
  ...webPublicVariableNames,
  "ENABLE_EXPERIMENTAL_COREPACK",
]);

const webVariableShape = {
  /** The api origin; the client appends `/v1/…`. */
  NEXT_PUBLIC_API_URL: originVariable("http"),
  /** The api's WebSocket origin; the client appends `/v1/ws`. */
  NEXT_PUBLIC_WS_URL: originVariable("ws"),
  /**
   * The PostHog project ingest key (`phc_…`), which is public by design. A personal API key
   * (`phx_…`) or any other value is rejected, so a server credential can never be bundled.
   */
  NEXT_PUBLIC_POSTHOG_KEY: posthogProjectKeyVariable(),
  NEXT_PUBLIC_POSTHOG_HOST: optionalOriginVariable("http"),
  /** Vercel project setting that enables Corepack so pnpm 12.4.2 is used (§1). */
  ENABLE_EXPERIMENTAL_COREPACK: z.literal("1", { error: "must be 1" }).optional(),
};

function requireSecureUnlessLoopback(
  issues: ConfigIssue[],
  variable: string,
  url: URL | null,
  scheme: "https" | "wss",
): void {
  if (url && !isSecureOrigin(url) && !isLoopbackHostname(url.hostname)) {
    issues.push({ variable, message: `must use ${scheme} unless it is a loopback host` });
  }
}

/** Validates the public web environment without throwing. */
export function parseWebConfig(env: EnvRecord): ConfigResult<WebPublicConfig> {
  const variables = presentVariables(env);
  const issues: ConfigIssue[] = [];

  for (const name of Object.keys(variables)) {
    if (isSecretVariable(name)) {
      issues.push({
        variable: name,
        message: "is a server secret and must never be configured for the web app",
      });
    } else if (
      name.startsWith("NEXT_PUBLIC_") &&
      !(webPublicVariableNames as readonly string[]).includes(name)
    ) {
      issues.push({
        variable: name,
        message:
          "is not an allowed public variable: only the documented NEXT_PUBLIC_* values reach the browser",
      });
    }
  }

  const parsed = z.object(webVariableShape).safeParse(variables, { error: fallbackIssueMessage });
  if (!parsed.success) {
    issues.push(...issuesFromZod(parsed.error));
    return { ok: false, issues: normalizeIssues(issues) };
  }
  const fields = parsed.data;

  const api = parseOrigin(fields.NEXT_PUBLIC_API_URL, "http");
  const ws = parseOrigin(fields.NEXT_PUBLIC_WS_URL, "ws");
  requireSecureUnlessLoopback(issues, "NEXT_PUBLIC_API_URL", api, "https");
  requireSecureUnlessLoopback(issues, "NEXT_PUBLIC_WS_URL", ws, "wss");
  if (api && ws && api.host !== ws.host) {
    issues.push({
      variable: "NEXT_PUBLIC_WS_URL",
      message: "must have the same host and port as NEXT_PUBLIC_API_URL",
    });
  }
  if (fields.NEXT_PUBLIC_POSTHOG_HOST !== undefined) {
    requireSecureUnlessLoopback(
      issues,
      "NEXT_PUBLIC_POSTHOG_HOST",
      parseOrigin(fields.NEXT_PUBLIC_POSTHOG_HOST, "http"),
      "https",
    );
  }
  if (
    fields.NEXT_PUBLIC_POSTHOG_KEY !== undefined &&
    fields.NEXT_PUBLIC_POSTHOG_HOST === undefined
  ) {
    issues.push({
      variable: "NEXT_PUBLIC_POSTHOG_HOST",
      message: "is required when NEXT_PUBLIC_POSTHOG_KEY is set",
    });
  }

  if (issues.length > 0) return { ok: false, issues: normalizeIssues(issues) };
  const config: WebPublicConfig = {
    NEXT_PUBLIC_API_URL: fields.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_WS_URL: fields.NEXT_PUBLIC_WS_URL,
  };
  if (fields.NEXT_PUBLIC_POSTHOG_KEY !== undefined) {
    config.NEXT_PUBLIC_POSTHOG_KEY = fields.NEXT_PUBLIC_POSTHOG_KEY;
  }
  if (fields.NEXT_PUBLIC_POSTHOG_HOST !== undefined) {
    config.NEXT_PUBLIC_POSTHOG_HOST = fields.NEXT_PUBLIC_POSTHOG_HOST;
  }
  return { ok: true, config: Object.freeze(config) };
}

/**
 * Validates the public web configuration. Next.js inlines only literal `process.env.NEXT_PUBLIC_*`
 * references, so client code passes them explicitly:
 * `loadWebConfig({ NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL, … })`. A build step may pass
 * the whole environment, which also proves no server secret is configured for the web app.
 * Throws a `ConfigError` naming every problem, never a value.
 */
export function loadWebConfig(env: EnvRecord): WebPublicConfig {
  return unwrapConfig("web", parseWebConfig(env));
}

/** The web schema as a Standard Schema. */
export const webPublicConfigSchema: z.ZodType<WebPublicConfig, EnvRecord> =
  envRecordSchema.transform((env, context) => {
    const result = parseWebConfig(env);
    if (result.ok) return result.config;
    for (const issue of result.issues) {
      context.addIssue({ code: "custom", message: issue.message, path: [issue.variable] });
    }
    return z.NEVER;
  }) as unknown as z.ZodType<WebPublicConfig, EnvRecord>;
