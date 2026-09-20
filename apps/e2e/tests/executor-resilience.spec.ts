import { expect, test } from "@playwright/test";
import { taskCreateResponseSchema } from "@symplist/contracts";
import {
  seedUncertainEffectRestart,
  uncertainEffectState,
} from "../src/helpers/executor-resilience.ts";
import { ownerApi } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

const responseText = "Scripted development response. No model or external action was called.";

test("restart and explicit Retry preserve an uncertain external action without resending it", async ({
  context,
  page,
}) => {
  const { userId } = await signIn(context);
  const http = await ownerApi(context);
  const created = await http.post("/tasks", {
    title: "Confirm an interrupted connected action",
    collection: "now",
  });
  expect(created.status(), await created.text()).toBe(201);
  const { task } = taskCreateResponseSchema.parse(await created.json());
  const proof = await seedUncertainEffectRestart(userId, task.id);
  expect(proof).toMatchObject({
    firstOutcome: "uncertain",
    restartedOutcome: "uncertain",
    invocationCount: 1,
    invocationStatus: "uncertain",
    effectObjectCount: 1,
    replayObjectCount: 0,
  });

  await page.goto(`/now/${task.id}`);
  if ((page.viewportSize()?.width ?? 1440) < 700)
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    page.getByText(
      "Simon’s run was interrupted. You can continue from the saved history; uncertain external actions are not repeated automatically.",
      { exact: true },
    ),
  ).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry interrupted run", exact: true });
  await expect(retry).toBeVisible();
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/v1/runs/${proof.interruptedRunId}/retry`),
  );
  await retry.click();
  expect((await accepted).status()).toBe(202);

  await expect(
    page.getByText(
      "The action’s outcome could not be confirmed. Check the connected service before trying another action.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(responseText, { exact: true })).toBeVisible();
  await expect(retry).toBeHidden();
  await expect
    .poll(() => uncertainEffectState(userId, proof.approvalId))
    .toEqual({
      invocationCount: 1,
      invocationStatus: "uncertain",
      effectObjectCount: 1,
      replayObjectCount: 0,
    });
});
