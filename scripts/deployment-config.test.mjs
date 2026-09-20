import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const render = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
const vercel = JSON.parse(readFileSync(new URL("../apps/web/vercel.json", import.meta.url), "utf8"));

function envEntry(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = render.match(
    new RegExp(`      - key: ${escaped}\\n((?:        [^\\n]+\\n?)+)`),
  );
  assert.ok(match, `render.yaml must declare ${name}`);
  return match[1];
}

test("Render deploys the paid Docker API only after checks, with both public hosts", () => {
  assert.match(render, /type: web/);
  assert.match(render, /runtime: docker/);
  assert.match(render, /plan: 0\.5c-512mb/);
  assert.match(render, /branch: main/);
  assert.match(render, /autoDeployTrigger: checksPass/);
  assert.match(render, /dockerfilePath: \.\/apps\/api\/Dockerfile/);
  assert.match(render, /dockerContext: \./);
  assert.match(render, /healthCheckPath: \/healthz/);
  assert.match(render, /preDeployCommand: node node_modules\/@symplist\/db\/dist\/cli\/migrate\.js --driver d1/);
  assert.match(render, /- api\.symplist\.tejassuds\.com/);
  assert.match(render, /- artifacts\.symplist\.tejassuds\.com/);
});

test("Render keeps production origins and durable executor placement explicit", () => {
  assert.match(envEntry("WEB_ORIGIN"), /value: https:\/\/symplist\.tejassuds\.com/);
  assert.match(envEntry("API_ORIGIN"), /value: https:\/\/api\.symplist\.tejassuds\.com/);
  assert.match(envEntry("WS_ORIGIN"), /value: wss:\/\/api\.symplist\.tejassuds\.com/);
  assert.match(
    envEntry("ARTIFACT_ORIGIN"),
    /value: https:\/\/artifacts\.symplist\.tejassuds\.com/,
  );
  assert.match(envEntry("DURABLE"), /value: "true"/);
  assert.match(envEntry("DATA_DRIVER"), /value: d1/);
  assert.match(envEntry("EMAIL_DRIVER"), /value: resend/);
  assert.match(envEntry("TRUST_PROXY_HOPS"), /value: "1"/);
});

test("Render prompts for every API secret and never carries worker, CI or model credentials", () => {
  const prompted = [
    "TRIGGER_SECRET_KEY",
    "TRIGGER_PROJECT_REF",
    "CLOUDFLARE_ACCOUNT_ID",
    "D1_DATABASE_ID",
    "CLOUDFLARE_D1_API_TOKEN",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "RESEND_API_KEY",
    "RESEND_WEBHOOK_SECRET",
    "COMPOSIO_API_KEY",
    "COMPOSIO_WEBHOOK_SECRET",
    "POSTHOG_PROJECT_KEY",
    "POSTHOG_PERSONAL_API_KEY",
    "POSTHOG_PROJECT_ID",
    "CONTENT_KEK_1",
    "INTERNAL_EVENT_SECRET_1",
    "REMINDER_UNSUBSCRIBE_SECRET_1",
    "VAULT_RECOVERY_KEY_1",
    "SESSION_DIGEST_SECRET_1",
    "OTP_DIGEST_SECRET_1",
    "INVITE_DIGEST_SECRET_1",
    "SHARE_DIGEST_SECRET_1",
    "SHARE_SESSION_DIGEST_SECRET_1",
    "MCP_TOKEN_DIGEST_SECRET_1",
    "MCP_OAUTH_SIGNING_KEY_1",
    "IDEMPOTENCY_SECRET_1",
  ];
  for (const name of prompted) assert.match(envEntry(name), /sync: false/);

  for (const forbidden of [
    "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "GOOGLE_VERTEX_CREDENTIALS_JSON",
    "TOGETHER_API_KEY",
    "CLOUDFLARE_D1_WORKER_API_TOKEN",
    "CLOUDFLARE_D1_MIGRATE_API_TOKEN",
    "TRIGGER_ACCESS_TOKEN",
  ]) {
    assert.doesNotMatch(render, new RegExp(`key: ${forbidden}(?:\\n|$)`));
  }
});

test("Vercel builds the workspace app from the monorepo with pinned Corepack pnpm", () => {
  assert.equal(vercel.$schema, "https://openapi.vercel.sh/vercel.json");
  assert.equal(vercel.framework, "nextjs");
  assert.equal(vercel.installCommand, "cd ../.. && pnpm install --frozen-lockfile");
  assert.equal(vercel.buildCommand, "cd ../.. && pnpm --filter @symplist/web build");
  assert.equal(vercel.env.ENABLE_EXPERIMENTAL_COREPACK, "1");
});
