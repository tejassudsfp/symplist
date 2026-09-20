import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedSecretBytes, generatedSecretFamilies } from "@symplist/config";
import { apiSecretFamilies } from "@symplist/config/api";

/**
 * The working directory of the api this suite starts: its SQLite file, its object store and the
 * environment it was started with. It sits outside `tests/`, is recreated on every run and is not
 * committed — the secrets in it are generated per run and never reach the repository.
 */
export const RUN_DIR = fileURLToPath(new URL("../../.local-e2e/", import.meta.url));

/** Where {@link writeRunEnv} puts the api's environment, so the seeder can use the same secrets. */
const ENV_FILE = join(RUN_DIR, "env.json");

export type RunEnv = Record<string, string>;

/**
 * The address the api promotes on its first verification (§5.7, `ADMIN_BOOTSTRAP_EMAIL`).
 * `access.spec.ts` signs this account in and administers the beta with it, so it belongs to the one
 * environment every spec shares rather than to the spec that happens to use it.
 */
export const E2E_ADMIN_EMAIL = "operator@example.test";

/**
 * A throwaway api environment for `DATA_DRIVER=local`, `EMAIL_DRIVER=log` and `DURABLE=false`
 * (§16.1), with a fresh value for every generated secret family the api holds (§4.5).
 *
 * `NODE_ENV=test` because `access.spec.ts` signs in the way a person does, through an emailed code,
 * and the api only keeps delivered codes for `POST /v1/auth/test/otp` in that environment (decision
 * AC12); with `development` the route answers `not_found` and no access journey can start. Nothing
 * else in the api reads `NODE_ENV` except to ask whether it is `production`, so the cookies,
 * drivers and startup migrations are the same as before.
 *
 * The origins are `127.0.0.1`, not `localhost`: the web build bakes `NEXT_PUBLIC_API_URL` in, and the
 * browser will only send the session cookie to the host the web app calls. The two ports are the
 * same site, so a `SameSite=Lax` cookie crosses between them.
 */
export function e2eApiEnv(options: { readonly apiPort: number; readonly webPort: number }): RunEnv {
  const families: RunEnv = {};
  for (const family of generatedSecretFamilies) {
    if (!apiSecretFamilies.includes(family)) continue;
    families[`${family}_1`] = randomBytes(generatedSecretBytes).toString("base64url");
    families[`${family}_CURRENT`] = "1";
  }
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    PORT: String(options.apiPort),
    WEB_ORIGIN: `http://127.0.0.1:${options.webPort}`,
    API_ORIGIN: `http://127.0.0.1:${options.apiPort}`,
    WS_ORIGIN: `ws://127.0.0.1:${options.apiPort}`,
    ARTIFACT_ORIGIN: `http://localhost:${options.apiPort}`,
    // Playwright talks directly to this process by default. Individual proxy-sensitive flows may
    // inject one X-Forwarded-For hop at the network route, matching production's trusted edge.
    TRUST_PROXY_HOPS: "1",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    AI_PROVIDER_MODE: "scripted",
    ANALYTICS_ENABLED: "true",
    POSTHOG_PROJECT_KEY: "phc_e2e_fixture_not_a_real_project_key",
    POSTHOG_HOST: "https://posthog.invalid",
    POSTHOG_PERSONAL_API_KEY: "phx_e2e_fixture_not_a_real_personal_key",
    POSTHOG_PROJECT_ID: "1",
    KEY_PROVIDER: "env",
    ADMIN_BOOTSTRAP_EMAIL: E2E_ADMIN_EMAIL,
    EMAIL_FROM_SECURITY: "Symplist <security@example.test>",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@example.test>",
    LOCAL_DATA_DIR: join(RUN_DIR, ".local-data"),
    ...families,
  };
}

export function writeRunEnv(env: RunEnv): void {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(ENV_FILE, JSON.stringify(env, null, 2), { mode: 0o600 });
}

/** The environment the running api was started with. Throws when no api was started by this suite. */
export function readRunEnv(): RunEnv {
  try {
    return JSON.parse(readFileSync(ENV_FILE, "utf8")) as RunEnv;
  } catch {
    throw new Error(
      `No api environment at ${ENV_FILE}. This spec needs the api Playwright starts; run it through \`pnpm e2e\` rather than against E2E_API_URL.`,
    );
  }
}
