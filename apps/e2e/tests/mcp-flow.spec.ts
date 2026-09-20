import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { taskCreateResponseSchema } from "@symplist/contracts";
import { readRunEnv } from "../src/helpers/local-api.ts";
import { mcpRequest, ownerApi, setAccessState } from "../src/helpers/phase-e.ts";
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

function rpcResult(exchange: Awaited<ReturnType<typeof mcpRequest>>, id: number) {
  expect(exchange.status).toBe(200);
  expect(exchange.body).toMatchObject({ jsonrpc: "2.0", id });
  expect(exchange.body).not.toHaveProperty("error");
  const result = exchange.body?.result;
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");
  return result as Record<string, unknown>;
}

function taskListOutput(exchange: Awaited<ReturnType<typeof mcpRequest>>, title: string) {
  const result = rpcResult(exchange, 2);
  expect(result.isError).not.toBe(true);
  expect(Array.isArray(result.content)).toBe(true);
  const text = (result.content as Array<Record<string, unknown>>).find(
    (item) => item.type === "text",
  )?.text;
  expect(typeof text).toBe("string");
  const output = JSON.parse(String(text)) as Record<string, unknown>;
  expect(Array.isArray(output.tasks)).toBe(true);
  expect(output.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ title })]));
  expect(output).toHaveProperty("nextCursor");
}

async function seedTask(context: Parameters<typeof ownerApi>[0], title: string) {
  const api = await ownerApi(context);
  const response = await api.post("/tasks", { title, collection: "now" });
  expect(response.status(), await response.text()).toBe(201);
  return taskCreateResponseSchema.parse(await response.json()).task;
}

async function callTaskList(
  request: Parameters<typeof mcpRequest>[0],
  token: string,
  title: string,
) {
  const ready = await mcpRequest(request, token, initialize);
  rpcResult(ready, 1);
  const listed = await mcpRequest(request, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "task_list", arguments: {} },
  });
  taskListOutput(listed, title);
}

test("one-time bearer key calls MCP, then an account relock rejects it", async ({
  context,
  page,
}) => {
  const account = await signIn(context);
  const title = "Bearer MCP list marker";
  await seedTask(context, title);
  await page.goto("/settings/agents");
  await expect(page.getByRole("heading", { name: "Agent connections" })).toBeVisible();
  await page.getByRole("button", { name: "Add connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Add agent connection" });
  await dialog.getByLabel("Connection name").fill("Browser MCP agent");
  await dialog.getByLabel("All current and future tasks").check();
  await dialog.getByRole("button", { name: "Create API key" }).click();
  const key = await page.getByLabel("One-time API key").inputValue();
  expect(key).toMatch(/^sym_[0-9a-f-]{36}_[A-Za-z0-9_-]+$/);

  await callTaskList(context.request, key, title);

  await setAccessState(account.userId, "relocked");
  const blocked = await mcpRequest(context.request, key, initialize);
  expect(blocked.status).toBe(401);
  expect(blocked.headers["www-authenticate"]).toContain("resource_metadata=");
});

test("OAuth consent issues a bearer JWT which works until relock", async ({ context, page }) => {
  const account = await signIn(context);
  const title = "OAuth MCP list marker";
  await seedTask(context, title);
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

  // The native client's callback server is not part of this browser fixture. Fulfil only that
  // callback navigation so the page can prove it followed the API's redirect without racing the
  // decision response body against the navigation that intentionally replaces the consent page.
  const callbackOrigin = new URL(redirect).origin;
  await page.route(
    (url) => url.origin === callbackOrigin && url.pathname === "/callback",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>OAuth callback received</title>",
      }),
  );

  await page.goto(consentUrl);
  await expect(page.getByRole("heading", { name: "Authorize agent access" })).toBeVisible();
  await expect(page.getByText("Unverified client")).toBeVisible();
  await page.getByLabel("All current and future tasks").check();
  const decided = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/oauth/requests/") && response.url().endsWith("/decision"),
  );
  const callbackReached = page.waitForURL(
    (url) => url.origin === callbackOrigin && url.pathname === "/callback",
  );
  await page.getByRole("button", { name: "Allow selected access" }).click();
  const [decision] = await Promise.all([decided, callbackReached]);
  expect(decision.status()).toBe(200);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("iss")).toBe(env.API_ORIGIN);
  expect(callback.searchParams.get("state")).toBe("browser-oauth-state");
  expect(callback.searchParams.get("code")).toBeTruthy();

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
  await callTaskList(context.request, token, title);

  await setAccessState(account.userId, "relocked");
  expect((await mcpRequest(context.request, token, initialize)).status).toBe(401);
});
