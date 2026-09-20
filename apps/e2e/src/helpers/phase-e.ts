import type { APIRequestContext, APIResponse, BrowserContext } from "@playwright/test";
import { localDataPaths } from "@symplist/config";
import { apiSecretFamilies } from "@symplist/config/api";
import { ReminderScanner } from "@symplist/core/scheduling";
import { createEnvKeyProvider } from "@symplist/crypto";
import { createLocalSqliteClient, int, sql, uuidv7 } from "@symplist/db";
import { readRunEnv } from "./local-api.ts";

/** Owner-authenticated requests to the actual API Playwright started. */
export interface OwnerApi {
  readonly origin: string;
  get(path: string): Promise<APIResponse>;
  post(path: string, data?: unknown): Promise<APIResponse>;
  put(path: string, data: unknown): Promise<APIResponse>;
  delete(path: string): Promise<APIResponse>;
}

export async function ownerApi(context: BrowserContext): Promise<OwnerApi> {
  const env = readRunEnv();
  const origin = env.API_ORIGIN ?? "";
  const webOrigin = env.WEB_ORIGIN ?? "";
  const csrf = await context.request.get(`${origin}/v1/auth/csrf`, {
    headers: { Origin: webOrigin },
  });
  if (!csrf.ok()) throw new Error(`CSRF setup failed with ${csrf.status()}`);
  const token = (await csrf.json()) as { token: string };
  const headers = {
    Origin: webOrigin,
    "X-Symplist-CSRF": token.token,
  };
  const mutation = (method: "post" | "put" | "delete", path: string, data?: unknown) =>
    context.request[method](`${origin}/v1${path}`, {
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      ...(data === undefined ? {} : { data }),
    });
  return {
    origin,
    get: (path) => context.request.get(`${origin}/v1${path}`, { headers: { Origin: webOrigin } }),
    post: (path, data) => mutation("post", path, data),
    put: (path, data) => mutation("put", path, data),
    delete: (path) => mutation("delete", path),
  };
}

function localDatabase() {
  const env = readRunEnv();
  return createLocalSqliteClient({
    path: localDataPaths(env.LOCAL_DATA_DIR ?? "").database,
    env,
  });
}

/** Changes only the account state; the next OTP creates a fresh session against that state. */
export async function setAccessState(
  userId: string,
  state: "unlocked" | "locked" | "relocked" | "suspended",
): Promise<void> {
  const db = localDatabase();
  const now = Date.now();
  try {
    await db.run(
      sql(
        `UPDATE users SET beta_state=:beta, suspended_at=:suspended,
         access_generation=access_generation+1, updated_at=:now, write_id=:write WHERE id=:owner`,
        {
          owner: userId,
          beta: state === "relocked" ? "relocked" : state === "locked" ? "locked" : "unlocked",
          suspended: state === "suspended" ? int(now) : null,
          now: int(now),
          write: uuidv7(now),
        },
      ),
    );
  } finally {
    db.close?.();
  }
}

/** Advances one share grant past its expiry without changing wall-clock time for the whole suite. */
export async function expireShareGrant(grantId: string): Promise<void> {
  const db = localDatabase();
  try {
    await db.run(
      sql("UPDATE share_grants SET expires_at=:past, write_id=:write WHERE id=:id", {
        id: grantId,
        past: int(Date.now() - 1),
        write: uuidv7(),
      }),
    );
  } finally {
    db.close?.();
  }
}

/**
 * Runs the real reminder scanner over the e2e database at a chosen instant. The browser still reads
 * the resulting encrypted notification through the running API; only time is injected here.
 */
export async function runReminderScan(now: number): Promise<{
  readonly occurrenceCount: number;
  readonly acceptedCount: number;
}> {
  const env = readRunEnv();
  const db = localDatabase();
  const keys = createEnvKeyProvider(env, { families: apiSecretFamilies });
  try {
    const state = await db.first(sql("SELECT mode,generation FROM executor_state WHERE id=1"));
    if (state?.mode !== "local") throw new Error("the e2e executor is not in local mode");
    const scanner = new ReminderScanner({
      db,
      keys,
      now: () => now,
      policy: { betaAccessRequired: true },
      remindersEnabled: true,
      emailEnabled: false,
      defaultZone: "UTC",
      email: { send: async () => ({ providerId: "e2e-disabled-email" }) },
      renderEmail: async ({ occurrenceId }) => ({
        to: "disabled@example.test",
        subject: "You have a task reminder",
        html: "<p>A reminder</p>",
        text: "A reminder",
        sender: "reminders",
        idempotencyKey: `reminder/${occurrenceId}/email`,
      }),
    });
    return await scanner.run({ executor: "local", generation: Number(state.generation) });
  } finally {
    keys.destroy();
    db.close?.();
  }
}

export interface McpExchange {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

/** One real stateless Streamable HTTP JSON-RPC request, accepting either JSON or SSE framing. */
export async function mcpRequest(
  request: APIRequestContext,
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<McpExchange> {
  const env = readRunEnv();
  const response = await request.post(`${env.API_ORIGIN}/mcp`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      Origin: env.WEB_ORIGIN ?? "",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    data: body,
  });
  const text = await response.text();
  const payload = response.headers()["content-type"]?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== "[DONE]")
        .at(-1)
    : text;
  let parsed: Record<string, unknown> | null = null;
  if (payload) {
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status(), headers: response.headers(), body: parsed };
}
