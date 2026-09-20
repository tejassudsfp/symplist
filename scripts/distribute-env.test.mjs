import { strict as assert } from "node:assert";
import { chmod, cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  checkDistributedEnvironment,
  distributeEnvironment,
  planEnvironmentDistribution,
  serializeEnvValue,
  validateDistributedVariables,
} from "./lib/distribute-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = new Set();

afterEach(async () => {
  await Promise.all([...scratch].map((path) => rm(path, { force: true, recursive: true })));
  scratch.clear();
});

function generatedSecret(seed) {
  return Buffer.alloc(32, seed).toString("base64url");
}

async function productionSource(overrides = {}) {
  const variables = parseEnv(await readFile(join(repoRoot, ".env.example"), "utf8"));
  Object.assign(variables, {
    NODE_ENV: "production",
    WEB_ORIGIN: "https://app.example.test",
    API_ORIGIN: "https://api.example.test",
    WS_ORIGIN: "wss://api.example.test",
    ARTIFACT_ORIGIN: "https://share.example.test",
    TRUST_PROXY_HOPS: "1",
    DATA_DRIVER: "d1",
    EMAIL_DRIVER: "resend",
    DURABLE: "true",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    D1_DATABASE_ID: "01234567-89ab-cdef-0123-456789abcdef",
    CLOUDFLARE_D1_API_TOKEN: "d1-api-token-unique",
    CLOUDFLARE_D1_WORKER_API_TOKEN: "d1-worker-token-unique",
    CLOUDFLARE_D1_MIGRATE_API_TOKEN: "d1-migrate-token-unique",
    R2_BUCKET: "symplist-test",
    R2_ACCESS_KEY_ID: "r2-access-key-unique",
    R2_SECRET_ACCESS_KEY: "r2-secret-key-unique",
    RESEND_API_KEY: "re_resend-key-unique",
    RESEND_WEBHOOK_SECRET: "whsec_resend-hook-unique",
    COMPOSIO_API_KEY: "composio-api-key-unique",
    COMPOSIO_WEBHOOK_SECRET: "composio-hook-unique",
    ANALYTICS_ENABLED: "true",
    POSTHOG_PROJECT_KEY: "phc_0123456789abcdefghijklmnop",
    POSTHOG_HOST: "https://us.i.posthog.com",
    POSTHOG_PERSONAL_API_KEY: "phx_personal-key-unique",
    POSTHOG_PROJECT_ID: "12345",
    OPENAI_API_KEY: "sk-openai-key-unique",
    TRIGGER_SECRET_KEY: "tr_prod_environment_key_unique",
    TRIGGER_PROJECT_REF: "proj_0123456789abcdef",
    NEXT_PUBLIC_API_URL: "https://api.example.test",
    NEXT_PUBLIC_WS_URL: "wss://api.example.test",
    NEXT_PUBLIC_POSTHOG_KEY: "phc_0123456789abcdefghijklmnop",
    NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
    ENABLE_EXPERIMENTAL_COREPACK: "1",
    R2_ACCOUNT_API_TOKEN: "account-management-token-unique",
  });
  const families = [
    "CONTENT_KEK",
    "INTERNAL_EVENT_SECRET",
    "REMINDER_UNSUBSCRIBE_SECRET",
    "VAULT_RECOVERY_KEY",
    "SESSION_DIGEST_SECRET",
    "OTP_DIGEST_SECRET",
    "INVITE_DIGEST_SECRET",
    "SHARE_DIGEST_SECRET",
    "SHARE_SESSION_DIGEST_SECRET",
    "MCP_TOKEN_DIGEST_SECRET",
    "MCP_OAUTH_SIGNING_KEY",
    "IDEMPOTENCY_SECRET",
  ];
  for (const [index, family] of families.entries()) {
    variables[`${family}_1`] = generatedSecret(index + 1);
    variables[`${family}_CURRENT`] = "1";
  }
  Object.assign(variables, overrides);
  return variables;
}

function envText(variables) {
  return `${Object.entries(variables)
    .map(([name, value]) => `${name}=${serializeEnvValue(value, name)}`)
    .join("\n")}\n`;
}

async function examples() {
  return Object.fromEntries(
    await Promise.all(
      ["api", "worker", "web"].map(async (runtime) => [
        runtime,
        await readFile(join(repoRoot, `apps/${runtime}/env.example`), "utf8"),
      ]),
    ),
  );
}

async function fixture(sourceOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "symplist-env-"));
  scratch.add(root);
  for (const runtime of ["api", "worker", "web"]) {
    const destination = join(root, `apps/${runtime}/env.example`);
    await cp(join(repoRoot, `apps/${runtime}/env.example`), destination, {
      force: true,
      recursive: true,
    });
  }
  const sourcePath = join(root, ".env.local");
  await writeFile(sourcePath, envText(await productionSource(sourceOverrides)), {
    mode: 0o600,
  });
  await chmod(sourcePath, 0o600);
  return { root, sourcePath };
}

test("splits a durable source by runtime, validates it and writes only private files", async () => {
  const { root, sourcePath } = await fixture({
    CONTENT_KEK_2: generatedSecret(22),
    CONTENT_KEK_CURRENT: "2",
  });
  const result = await distributeEnvironment({ repoRoot: root, sourcePath });
  assert.equal(result.sourceOnlyCount, 2);

  const api = parseEnv(await readFile(join(root, "apps/api/.env"), "utf8"));
  const worker = parseEnv(await readFile(join(root, "apps/worker/.env"), "utf8"));
  const web = parseEnv(await readFile(join(root, "apps/web/.env"), "utf8"));

  assert.equal(api.OPENAI_API_KEY, undefined);
  assert.equal(api.CLOUDFLARE_D1_WORKER_API_TOKEN, undefined);
  assert.equal(api.CLOUDFLARE_D1_MIGRATE_API_TOKEN, undefined);
  assert.equal(worker.OPENAI_API_KEY, "sk-openai-key-unique");
  assert.equal(worker.TRIGGER_SECRET_KEY, undefined);
  assert.equal(worker.CLOUDFLARE_D1_API_TOKEN, undefined);
  assert.equal(worker.RESEND_WEBHOOK_SECRET, undefined);
  assert.equal(worker.VAULT_RECOVERY_KEY_1, undefined);
  assert.equal(web.TRIGGER_SECRET_KEY, undefined);
  assert.deepEqual(Object.keys(web).sort(), [
    "ENABLE_EXPERIMENTAL_COREPACK",
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_POSTHOG_HOST",
    "NEXT_PUBLIC_POSTHOG_KEY",
    "NEXT_PUBLIC_WS_URL",
  ]);
  for (const name of [
    "CONTENT_KEK_1",
    "CONTENT_KEK_2",
    "CONTENT_KEK_CURRENT",
    "INTERNAL_EVENT_SECRET_1",
    "REMINDER_UNSUBSCRIBE_SECRET_1",
  ]) {
    assert.equal(worker[name], api[name]);
  }
  for (const runtime of ["api", "worker", "web"]) {
    assert.equal((await stat(join(root, `apps/${runtime}/.env`))).mode & 0o777, 0o600);
  }
  await checkDistributedEnvironment({ repoRoot: root });
});

test("keeps model credentials in the api only for the local non-durable executor", async () => {
  const source = await productionSource({
    NODE_ENV: "development",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:4000",
    WS_ORIGIN: "ws://localhost:4000",
    ARTIFACT_ORIGIN: "http://127.0.0.1:4000",
    NEXT_PUBLIC_API_URL: "http://localhost:4000",
    NEXT_PUBLIC_WS_URL: "ws://localhost:4000",
  });
  const plan = planEnvironmentDistribution(envText(source), await examples());
  const api = parseEnv(plan.api.text);
  const worker = parseEnv(plan.worker.text);
  assert.equal(api.OPENAI_API_KEY, "sk-openai-key-unique");
  assert.equal(worker.OPENAI_API_KEY, "sk-openai-key-unique");
});

test("round-trips whitespace, hashes, JSON, backslashes and multiline values", () => {
  for (const value of [
    "plain",
    "Symplist <reminders@example.test>",
    "value#with-hash",
    '{"private_key":"line\\nline"}',
    "first line\nsecond line",
    "O'Brien",
  ]) {
    assert.equal(parseEnv(`VALUE=${serializeEnvValue(value)}`).VALUE, value);
  }
});

test("rejects misplaced worker secrets without echoing their values", async () => {
  const { root, sourcePath } = await fixture();
  await distributeEnvironment({ repoRoot: root, sourcePath });
  const workerPath = join(root, "apps/worker/.env");
  const canary = "tr_prod_PRIVATE_CANARY_VALUE";
  await writeFile(
    workerPath,
    `${await readFile(workerPath, "utf8")}TRIGGER_SECRET_KEY=${canary}\n`,
    {
      mode: 0o600,
    },
  );
  await assert.rejects(
    checkDistributedEnvironment({ repoRoot: root }),
    (error) =>
      error instanceof Error &&
      error.message.includes("TRIGGER_SECRET_KEY") &&
      !error.message.includes(canary),
  );
});

test("rejects unowned variables instead of silently carrying them", async () => {
  const source = await productionSource();
  const plan = planEnvironmentDistribution(envText(source), await examples());
  const variables = {
    api: { ...parseEnv(plan.api.text), UNRECOGNIZED_PRIVATE_VALUE: "canary-private-value" },
    worker: parseEnv(plan.worker.text),
    web: parseEnv(plan.web.text),
  };
  assert.throws(
    () => validateDistributedVariables(variables),
    (error) =>
      error instanceof Error &&
      error.message.includes("UNRECOGNIZED_PRIVATE_VALUE") &&
      !error.message.includes("canary-private-value"),
  );
});

test("rejects an unowned source assignment by name without exposing its value", async () => {
  const canary = "canary-private-source-value";
  const source = await productionSource({ MISSPELLED_PROVIDER_SECRET: canary });
  await assert.rejects(
    async () => planEnvironmentDistribution(envText(source), await examples()),
    (error) =>
      error instanceof Error &&
      error.message.includes("MISSPELLED_PROVIDER_SECRET") &&
      !error.message.includes(canary),
  );
});

test("validates the complete plan before replacing any destination", async () => {
  const canary = "PRIVATE_GENERATED_SECRET_CANARY";
  const { root, sourcePath } = await fixture({ CONTENT_KEK_1: canary });
  for (const runtime of ["api", "worker", "web"]) {
    const path = join(root, `apps/${runtime}/.env`);
    await writeFile(path, `SENTINEL=${runtime}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  await assert.rejects(
    distributeEnvironment({ repoRoot: root, sourcePath }),
    (error) => error instanceof Error && !error.message.includes(canary),
  );
  for (const runtime of ["api", "worker", "web"]) {
    assert.equal(
      await readFile(join(root, `apps/${runtime}/.env`), "utf8"),
      `SENTINEL=${runtime}\n`,
    );
  }
});

test("requires the three shared family versions and values to match", async () => {
  const source = await productionSource();
  const plan = planEnvironmentDistribution(envText(source), await examples());
  const variables = {
    api: parseEnv(plan.api.text),
    worker: parseEnv(plan.worker.text),
    web: parseEnv(plan.web.text),
  };
  variables.worker.CONTENT_KEK_1 = generatedSecret(31);
  assert.throws(
    () => validateDistributedVariables(variables),
    /CONTENT_KEK_1: api and worker values must match/,
  );
});
