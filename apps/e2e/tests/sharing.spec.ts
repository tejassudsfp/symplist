import { expect, test } from "@playwright/test";
import { documentPublishResponseSchema, taskCreateResponseSchema } from "@symplist/contracts";
import { readRunEnv } from "../src/helpers/local-api.ts";
import { signIn } from "../src/helpers/session.ts";

/** Real API and encrypted local object store; no endpoint interception for this cross-feature flow. */
test("saved document → private snapshot → reviewed link → isolated viewer → revocation", async ({
  page,
  context,
}) => {
  await signIn(context);
  const env = readRunEnv();
  const origin = env.API_ORIGIN ?? "";
  const csrfResponse = await context.request.get(`${origin}/v1/auth/csrf`, {
    headers: { Origin: env.WEB_ORIGIN ?? "" },
  });
  expect(csrfResponse.ok()).toBe(true);
  const csrf = (await csrfResponse.json()) as { token: string };
  const write = (path: string, data: unknown) =>
    context.request.post(`${origin}${path}`, {
      headers: {
        Origin: env.WEB_ORIGIN ?? "",
        "X-Symplist-CSRF": csrf.token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      data,
    });
  const taskResponse = await write("/v1/tasks", {
    title: "Review launch handoff",
    collection: "now",
  });
  expect(taskResponse.status()).toBe(201);
  const { task } = taskCreateResponseSchema.parse(await taskResponse.json());
  const save = await write(`/v1/tasks/${task.id}/document/commits`, {
    baseRevision: null,
    markdown: "# Launch outline\nA reviewed source for the next collaborator.\n",
  });
  expect(save.status()).toBe(201);
  documentPublishResponseSchema.parse(await save.json());
  await page.goto(`/tasks/${task.id}/artifacts`);
  await expect(
    page.getByRole("heading", { name: "Artifacts and links", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New snapshot" }).click();
  await page.getByLabel("Snapshot name").fill("Reviewed launch outline");
  await page.getByRole("button", { name: "Create private snapshot" }).click();
  const review = page.getByRole("dialog", { name: "Share this snapshot" });
  await expect(review).toBeVisible();
  await review.getByText("Preview exactly what will be shared").click();
  await expect(review.getByText("A reviewed source for the next collaborator.")).toBeVisible();
  await review.getByRole("button", { name: "Create expiring link" }).click();
  const link = page.getByRole("textbox", { name: "Keep this link before closing" });
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(new URL(url).hostname).not.toBe(new URL(env.WEB_ORIGIN ?? "").hostname);
  const viewer = await context.newPage();
  await viewer.goto(url);
  await expect(
    viewer.getByRole("heading", { level: 1, name: "Reviewed launch outline" }),
  ).toBeVisible();
  await expect(viewer.getByText("A reviewed source for the next collaborator.")).toBeVisible();
  await expect(viewer.locator("script")).toHaveCount(0);
  await expect(viewer.locator("img,iframe,video,audio")).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /Revoke/ })
    .click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  await viewer.reload();
  await expect(viewer.getByRole("heading", { name: "This artifact is unavailable" })).toBeVisible();
  await viewer.close();
});
