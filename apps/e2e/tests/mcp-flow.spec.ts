import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { readRunEnv } from "../src/helpers/local-api.ts";
import { mcpRequest, setAccessState } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "Symplist browser flow", version: "1.0" },
  },
};

async function callTaskList(request: Parameters<typeof mcpRequest>[0], token: string) {
  const ready = await mcpRequest(request, token, initialize);
  expect(ready.status).toBe(200);
  expect(ready.body).toMatchObject({ jsonrpc: "2.0", id: 1 });
  return mcpRequest(request, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "task_list", arguments: {} },
  });
}

test("one-time bearer key calls MCP, then an account relock rejects it", async ({
  context,
  page,
}) => {
  const account = await signIn(context);
  await page.goto("/settings/agents");
  await expect(page.getByRole("heading", { name: "Agent connections" })).toBeVisible();
  await page.getByRole("button", { name: "Add connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Add agent connection" });
  await dialog.getByLabel("Connection name").fill("Browser MCP agent");
  await dialog.getByLabel("All current and future tasks").check();
  await dialog.getByRole("button", { name: "Create API key" }).click();
  const key = await page.getByLabel("One-time API key").inputValue();
  expect(key).toMatch(/^sym_[0-9a-f-]{36}_[A-Za-z0-9_-]+$/);

  const listed = await callTaskList(context.request, key);
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).toContain("tasks");

  await setAccessState(account.userId, "relocked");
  const blocked = await mcpRequest(context.request, key, initialize);
  expect(blocked.status).toBe(401);
  expect(blocked.headers["www-authenticate"]).toContain("resource_metadata=");
});

test("OAuth consent issues a bearer JWT which works until relock", async ({ context, page }) => {
  const account = await signIn(context);
  const env = readRunEnv();
  const redirect = "http://127.0.0.1:45678/callback";
  const verifier = "v".repeat(43);
  const registration = await context.request.post(`${env.API_ORIGIN}/oauth/register`, {
    data: {
      client_name: "Browser OAuth MCP client",
      application_type: "native",
      redirect_uris: [redirect],
    },
  });
  expect(registration.status(), await registration.text()).toBe(201);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${env.API_ORIGIN}/mcp`,
    scope: "tasks:read offline_access",
    state: "browser-oauth-state",
  });
  const authorize = await context.request.get(`${env.API_ORIGIN}/oauth/authorize?${query}`, {
    maxRedirects: 0,
  });
  expect(authorize.status()).toBe(303);
  const consentUrl = authorize.headers().location;
  if (!consentUrl) throw new Error("OAuth authorization did not return a consent location");
  expect(consentUrl).toContain("/oauth/consent?request=");

  await page.goto(consentUrl);
  await expect(page.getByRole("heading", { name: "Authorize agent access" })).toBeVisible();
  await expect(page.getByText("Unverified client")).toBeVisible();
  await page.getByLabel("All current and future tasks").check();
  const decided = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/oauth/requests/") && response.url().endsWith("/decision"),
  );
  await page.getByRole("button", { name: "Allow selected access" }).click();
  const decision = await decided;
  expect(decision.status(), await decision.text()).toBe(200);
  const redirectUrl = ((await decision.json()) as { redirectUrl?: string }).redirectUrl;
  expect(redirectUrl).toBeTruthy();
  const callback = new URL(redirectUrl ?? "");
  expect(callback.searchParams.get("iss")).toBe(env.API_ORIGIN);

  const exchange = await context.request.post(`${env.API_ORIGIN}/oauth/token`, {
    data: {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: clientId,
      resource: `${env.API_ORIGIN}/mcp`,
    },
  });
  expect(exchange.status(), await exchange.text()).toBe(200);
  const token = ((await exchange.json()) as { access_token: string }).access_token;
  const listed = await callTaskList(context.request, token);
  expect(listed.status).toBe(200);

  await setAccessState(account.userId, "relocked");
  expect((await mcpRequest(context.request, token, initialize)).status).toBe(401);
});
