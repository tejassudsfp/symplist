import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { taskCreateResponseSchema } from "@symplist/contracts";
import { captureEvidence, expectNoAxeViolations } from "../src/helpers/index.ts";
import { readRunEnv } from "../src/helpers/local-api.ts";
import { signIn } from "../src/helpers/session.ts";
import { seedSimonPause } from "../src/helpers/simon.ts";

const responseText = "Scripted development response. No model or external action was called.";
const evidenceDir = fileURLToPath(new URL("../evidence/simon", import.meta.url));

async function paused(context: BrowserContext, kind: "question" | "approval") {
  const { userId } = await signIn(context);
  const http = await api(context);
  const result = await http.post("/tasks", {
    title: "Review a proposed next step",
    collection: "now",
  });
  expect(result.status()).toBe(201);
  const { task } = taskCreateResponseSchema.parse(await result.json());
  const pause = await seedSimonPause(userId, task.id, kind);
  return { http, taskId: task.id, ...pause };
}

async function api(context: BrowserContext) {
  const env = readRunEnv();
  const headers = { Origin: env.WEB_ORIGIN ?? "" };
  const csrf = await context.request.get(`${env.API_ORIGIN}/v1/auth/csrf`, { headers });
  expect(csrf.ok()).toBe(true);
  const { token } = await csrf.json();
  return {
    get: (path: string) => context.request.get(`${env.API_ORIGIN}/v1${path}`, { headers }),
    post: (path: string, data: unknown) =>
      context.request.post(`${env.API_ORIGIN}/v1${path}`, {
        headers: { ...headers, "X-Symplist-CSRF": token, "Idempotency-Key": crypto.randomUUID() },
        data,
      }),
  };
}

async function openChat(page: Page, taskId: string) {
  await page.goto(`/now/${taskId}`);
  if ((page.viewportSize()?.width ?? 1440) < 700) {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  }
  await expect(page.locator(".sym-simon-composer textarea")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Simon", exact: true })).toHaveCount(0);
}

test("task chat sends with Mod+Enter, suppresses IME submission and restores history without duplicates", async ({
  context,
  page,
}, testInfo) => {
  // Keep the native transport and its real messages. Retain handles only to force a deterministic
  // disconnect: browser offline emulation alone does not consistently close existing WebSockets.
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets = new Set<WebSocket>();
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.add(this);
        this.addEventListener("close", () => sockets.delete(this));
      }
    };
    Object.assign(window, {
      disconnectSimonTestSockets: () => {
        const count = sockets.size;
        for (const socket of sockets) socket.close(1000, "browser reconnect test");
        return count;
      },
    });
  });
  await signIn(context);
  const http = await api(context);
  const created = await http.post("/tasks", {
    title: "Review the portfolio outline",
    collection: "now",
  });
  expect(created.status()).toBe(201);
  const { task } = taskCreateResponseSchema.parse(await created.json());
  await openChat(page, task.id);
  const composer = page.getByLabel("Message Simon", { exact: true });
  await composer.fill("Help me tighten the Projects section.");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Help me tighten the Projects section.\n");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/conversations\/[^/]+\/messages$/.test(request.url()))
      submissions.push(request.url());
  });
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    metaKey: process.platform === "darwin",
    ctrlKey: process.platform !== "darwin",
    isComposing: true,
  });
  await expect(composer).not.toHaveValue("");
  expect(submissions).toHaveLength(0);
  await composer.press("ControlOrMeta+Enter");
  await expect(page.getByText(responseText, { exact: true })).toHaveCount(1);
  expect(submissions).toHaveLength(1);
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  await context.setOffline(true);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          disconnectSimonTestSockets: () => number;
        }
      ).disconnectSimonTestSockets(),
    ),
  ).toBeGreaterThan(0);
  await expect(page.getByText(/Live updates are unavailable|Reconnecting…/)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText(/Live updates are unavailable|Reconnecting…/)).toBeHidden();
  await expect(page.getByText(responseText, { exact: true })).toHaveCount(1);
  await page.reload();
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText(responseText, { exact: true })).toHaveCount(1);
  await expect(
    page.getByText("Help me tighten the Projects section.", { exact: true }),
  ).toHaveCount(1);
  await expectNoAxeViolations(page, testInfo);
  await captureEvidence(
    page,
    testInfo,
    { screen: "task_chat", state: "completed" },
    { keepIn: evidenceDir },
  );
});

test("quick chat closes with deletion and opens a fresh conversation", async ({
  context,
  page,
}, testInfo) => {
  await signIn(context);
  const http = await api(context);
  await page.goto("/now");
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/v1/conversations"),
  );
  await page.getByRole("button", { name: "Ask Simon", exact: true }).click();
  const { conversationId } = await (await created).json();
  const dialog = page.getByRole("dialog", { name: "Simon", exact: true });
  await dialog.getByLabel("Message Simon", { exact: true }).fill("Help me plan a calm afternoon.");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(dialog.getByText(responseText, { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, testInfo);
  await captureEvidence(
    page,
    testInfo,
    { screen: "quick_chat", state: "temporary-conversation" },
    { keepIn: evidenceDir },
  );
  await dialog.getByRole("button", { name: "Close and delete quick chat" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Ask Simon", exact: true })).toBeFocused();
  expect((await http.get(`/conversations/${conversationId}`)).status()).toBe(404);
  await page.getByRole("button", { name: "Ask Simon", exact: true }).click();
  await expect(
    dialog.getByText("Your workspace helper. Ask a question or turn an idea into a task."),
  ).toBeVisible();
  await expect(dialog.getByText(responseText, { exact: true })).toHaveCount(0);
});

test("saving quick chat as a task preserves its conversation through reload", async ({
  context,
  page,
}, testInfo) => {
  await signIn(context);
  await page.goto("/now");
  await page.getByRole("button", { name: "Ask Simon", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Simon", exact: true });
  await dialog
    .getByLabel("Message Simon", { exact: true })
    .fill("Turn my launch idea into a task.");
  await dialog.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(dialog.getByText(responseText, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save as task", exact: true }).click();
  await dialog.getByLabel("Task title", { exact: true }).fill("Draft the launch outline");
  await dialog.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/now\/[0-9a-f-]{36}$/);
  await page.reload();
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText(responseText, { exact: true })).toHaveCount(1);
  await expect(page.getByText("Turn my launch idea into a task.", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Ask Simon", exact: true })).toHaveCount(0);
  await captureEvidence(
    page,
    testInfo,
    { screen: "quick_chat", state: "saved-as-task" },
    { keepIn: evidenceDir },
  );
});

test("Stop terminates a paused task run and preserves its existing output", async ({
  context,
  page,
}, testInfo) => {
  const fixture = await paused(context, "question");
  await openChat(page, fixture.taskId);
  await expect(page.getByRole("region", { name: "Simon has a question" })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByText("Stopped. The reply above is preserved; completed actions were not undone."),
  ).toBeVisible();
  await expect(page.getByText("I checked the outline.", { exact: true })).toHaveCount(1);
  const run = await fixture.http.get(`/runs/${fixture.runId}`);
  expect(await run.json()).toMatchObject({ status: "stopped" });
  await captureEvidence(
    page,
    testInfo,
    { screen: "task_chat", state: "stopped" },
    { keepIn: evidenceDir },
  );
});

test("question composer answers the exact pending question through the owner API", async ({
  context,
  page,
}, testInfo) => {
  const fixture = await paused(context, "question");
  await openChat(page, fixture.taskId);
  const answer = page.getByLabel("Answer Simon’s question", { exact: true });
  await expect(answer).toBeVisible();
  await answer.fill("Start with the Projects section.");
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/user-asks/${fixture.pauseId}/answer`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByRole("region", { name: "Simon has a question" })).toBeHidden();
  const question = await fixture.http.get(`/user-asks/${fixture.pauseId}`);
  expect(await question.json()).toMatchObject({
    status: "answered",
    answer: "Start with the Projects section.",
  });
  await expectNoAxeViolations(page, testInfo);
});

test("approval exposes exact action details and denial never authorizes the action", async ({
  context,
  page,
}, testInfo) => {
  const fixture = await paused(context, "approval");
  await openChat(page, fixture.taskId);
  const card = page.getByRole("region", { name: "Action needs your approval" });
  await expect(card).toBeVisible();
  await expect(card.locator("pre").first()).toContainText("collaborator@example.test");
  await expectNoAxeViolations(page, testInfo);
  await captureEvidence(
    page,
    testInfo,
    { screen: "agent_approval", state: "pending-review" },
    { keepIn: evidenceDir },
  );
  await card.getByRole("button", { name: "Don’t do this", exact: true }).click();
  await expect(card).toBeHidden();
  const approval = await fixture.http.get(`/approvals/${fixture.pauseId}`);
  expect(await approval.json()).toMatchObject({ status: "denied" });
  await page.reload();
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText("Action denied.", { exact: true })).toBeVisible();
});
