import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { taskCreateResponseSchema } from "@symplist/contracts";
import { captureEvidence, expectNoAxeViolations } from "../src/helpers/index.ts";
import { ownerApi } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";
import {
  latestScriptedConnectionAction,
  scriptedConnectionDirective,
  seedScriptedConnection,
} from "../src/helpers/simon-connections.ts";

const evidenceDir = fileURLToPath(new URL("../evidence/simon-connections", import.meta.url));

async function openChat(page: Page, taskId: string) {
  await page.goto(`/now/${taskId}`);
  if ((page.viewportSize()?.width ?? 1440) < 700) {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  }
  await expect(page.getByLabel("Message Simon", { exact: true })).toBeVisible();
}

async function setup(page: Page, context: Parameters<typeof signIn>[0]) {
  const account = await signIn(context);
  const connection = await seedScriptedConnection(account.userId);
  const http = await ownerApi(context);
  const created = await http.post("/tasks", {
    title: "Approve a connected email action",
    collection: "now",
  });
  expect(created.status(), await created.text()).toBe(201);
  const { task } = taskCreateResponseSchema.parse(await created.json());
  await openChat(page, task.id);
  return { account, connection, http, task };
}

test("Simon proposes exact connector arguments and executes the approved account once", async ({
  context,
  page,
}, testInfo) => {
  const fixture = await setup(page, context);
  const action = {
    connectionId: fixture.connection.connectionId,
    recipient: "collaborator@example.test",
    subject: "Reviewed launch outline",
    body: "Please review the exact approved outline.",
  };
  await page
    .getByLabel("Message Simon", { exact: true })
    .fill(`Prepare this email for review. ${scriptedConnectionDirective(action)}`);
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  const card = page.getByRole("region", { name: "Action needs your approval" });
  await expect(card).toBeVisible();
  await expect(card).toContainText(fixture.connection.alias);
  await expect(card).toContainText("Send email");
  await card.getByText("Exact action fields", { exact: true }).click();
  const exact = card.getByRole("textbox", { name: "Exact action fields" });
  await expect(exact).toBeVisible();
  const exactValue = await exact.inputValue();
  expect(exactValue).toContain(action.recipient);
  expect(exactValue).toContain(action.subject);
  expect(exactValue).toContain(action.body);
  const pending = await latestScriptedConnectionAction(fixture.account.userId, fixture.task.id);
  expect(pending.approval).toMatchObject({
    status: "pending",
    toolSlug: "GMAIL_SEND_EMAIL",
    connectionId: action.connectionId,
    arguments: {
      recipient: action.recipient,
      subject: action.subject,
      body: action.body,
    },
  });
  expect(pending.invocationStatuses).toEqual([]);
  await expectNoAxeViolations(page, testInfo);
  await captureEvidence(
    page,
    testInfo,
    { screen: "agent_approval", state: "exact-connected-action" },
    { keepIn: evidenceDir },
  );

  const decided = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/v1/approvals/${pending.approval.id}/decision`),
  );
  await card.getByRole("button", { name: "Approve action", exact: true }).click();
  expect((await decided).status()).toBe(200);
  await expect(page.getByText("Action succeeded.", { exact: true })).toBeVisible();
  await expect(page.getByText("The connected action succeeded.", { exact: true })).toBeVisible();
  const completed = await latestScriptedConnectionAction(fixture.account.userId, fixture.task.id);
  expect(completed.approval.status).toBe("approved");
  expect(completed.invocationStatuses).toEqual(["succeeded"]);
});

test("an uncertain connector outcome stays uncertain and a repeated decision cannot resend it", async ({
  context,
  page,
}, testInfo) => {
  const fixture = await setup(page, context);
  const action = {
    connectionId: fixture.connection.connectionId,
    recipient: "uncertain@example.test",
    subject: "Potentially accepted action",
    body: "Do not retry this action blindly.",
  };
  await page
    .getByLabel("Message Simon", { exact: true })
    .fill(`Prepare this uncertain email for review. ${scriptedConnectionDirective(action)}`);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const card = page.getByRole("region", { name: "Action needs your approval" });
  await expect(card).toBeVisible();
  const pending = await latestScriptedConnectionAction(fixture.account.userId, fixture.task.id);

  await card.getByRole("button", { name: "Approve action", exact: true }).click();
  const warning =
    "The action’s outcome could not be confirmed. Check the connected service before trying another action.";
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "The connected action’s outcome could not be confirmed. Check Gmail before trying again.",
      { exact: true },
    ),
  ).toBeVisible();
  let recorded = await latestScriptedConnectionAction(fixture.account.userId, fixture.task.id);
  expect(recorded.approval.status).toBe("approved");
  expect(recorded.invocationStatuses).toEqual(["uncertain"]);

  const duplicate = await fixture.http.post(`/approvals/${pending.approval.id}/decision`, {
    decision: "approve",
    argDigest: pending.approval.argDigest,
  });
  expect(duplicate.status()).toBe(409);
  recorded = await latestScriptedConnectionAction(fixture.account.userId, fixture.task.id);
  expect(recorded.invocationStatuses).toEqual(["uncertain"]);

  await page.reload();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  }
  await expect(page.getByText(warning, { exact: true })).toHaveCount(1);
  await expectNoAxeViolations(page, testInfo);
  await captureEvidence(
    page,
    testInfo,
    { screen: "agent_approval", state: "uncertain-no-retry" },
    { keepIn: evidenceDir },
  );
});
