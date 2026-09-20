import { expect, test } from "@playwright/test";
import { documentPublishResponseSchema, taskCreateResponseSchema } from "@symplist/contracts";
import { readRunEnv } from "../src/helpers/local-api.ts";
import { setAccessState } from "../src/helpers/phase-e.ts";
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

test("password and public variants keep independent access rules, while relock disables both", async ({
  page,
  context,
}) => {
  const account = await signIn(context);
  const env = readRunEnv();
  const origin = env.API_ORIGIN ?? "";
  const csrf = await context.request.get(`${origin}/v1/auth/csrf`, {
    headers: { Origin: env.WEB_ORIGIN ?? "" },
  });
  const token = ((await csrf.json()) as { token: string }).token;
  const post = (path: string, data: unknown) =>
    context.request.post(`${origin}${path}`, {
      headers: {
        Origin: env.WEB_ORIGIN ?? "",
        "X-Symplist-CSRF": token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      data,
    });
  const created = await post("/v1/tasks", { title: "Share variants", collection: "now" });
  const task = taskCreateResponseSchema.parse(await created.json()).task;
  const saved = await post(`/v1/tasks/${task.id}/document/commits`, {
    baseRevision: null,
    markdown: "# Variant source\nA deliberately pinned document.\n",
  });
  expect(saved.status(), await saved.text()).toBe(201);

  await page.goto(`/tasks/${task.id}/artifacts`);
  await page.getByRole("button", { name: "New snapshot" }).click();
  await page.getByLabel("Snapshot name").fill("Variant snapshot");
  await page.getByRole("button", { name: "Create private snapshot" }).click();
  const passwordDialog = page.getByRole("dialog", { name: "Share this snapshot" });
  await passwordDialog.getByRole("radio", { name: "Link and password" }).check();
  await passwordDialog.getByLabel(/Share password/).fill("separate-password");
  await passwordDialog.getByRole("button", { name: "Create expiring link" }).click();
  const passwordUrl = await passwordDialog
    .getByRole("textbox", { name: "Keep this link before closing" })
    .inputValue();
  await passwordDialog.getByRole("button", { name: "Done" }).click();

  const passwordViewer = await context.newPage();
  await passwordViewer.goto(passwordUrl);
  await expect(passwordViewer.getByRole("heading", { name: "A password is needed" })).toBeVisible();
  await passwordViewer.getByLabel("Password").fill("separate-password");
  await passwordViewer.getByRole("button", { name: "Open artifact" }).click();
  await expect(passwordViewer.getByRole("heading", { name: "Variant snapshot" })).toBeVisible();
  await expect(passwordViewer.locator("body")).not.toContainText("separate-password");

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const publicDialog = page.getByRole("dialog", { name: "Share this snapshot" });
  await publicDialog.getByRole("radio", { name: "Public artifact" }).check();
  await publicDialog.getByLabel("I understand anyone can read this public artifact.").check();
  await publicDialog.getByRole("button", { name: "Publish read-only artifact" }).click();
  const publicUrl = await publicDialog
    .getByRole("textbox", { name: "Keep this link before closing" })
    .inputValue();
  expect(new URL(publicUrl).searchParams.has("key")).toBe(false);
  const publicViewer = await context.newPage();
  await publicViewer.goto(publicUrl);
  await expect(publicViewer.getByRole("heading", { name: "Variant snapshot" })).toBeVisible();

  await setAccessState(account.userId, "relocked");
  await passwordViewer.reload();
  await publicViewer.reload();
  await expect(
    passwordViewer.getByRole("heading", { name: "This artifact is unavailable" }),
  ).toBeVisible();
  await expect(
    publicViewer.getByRole("heading", { name: "This artifact is unavailable" }),
  ).toBeVisible();
  await passwordViewer.close();
  await publicViewer.close();
});

test("a manual handoff remains private until its selected artifact is explicitly released", async ({
  page,
  context,
}) => {
  await signIn(context);
  const env = readRunEnv();
  const csrf = await context.request.get(`${env.API_ORIGIN}/v1/auth/csrf`, {
    headers: { Origin: env.WEB_ORIGIN ?? "" },
  });
  const headers = {
    Origin: env.WEB_ORIGIN ?? "",
    "X-Symplist-CSRF": ((await csrf.json()) as { token: string }).token,
    "Idempotency-Key": crypto.randomUUID(),
  };
  const created = await context.request.post(`${env.API_ORIGIN}/v1/tasks`, {
    headers,
    data: { title: "Prepare a handoff", collection: "now" },
  });
  const task = taskCreateResponseSchema.parse(await created.json()).task;
  const commit = await context.request.post(
    `${env.API_ORIGIN}/v1/tasks/${task.id}/document/commits`,
    {
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      data: { baseRevision: null, markdown: "# Brief\nA private handoff source.\n" },
    },
  );
  expect(commit.status(), await commit.text()).toBe(201);

  await page.goto(`/tasks/${task.id}/handoff`);
  await expect(page.getByRole("heading", { name: "Prepare handoff" })).toBeVisible();
  await page.getByLabel("Desired outcome").fill("Return a reviewed implementation plan.");
  await page.getByRole("button", { name: "Start a manual draft" }).click();
  const prompt = page.getByLabel("Editable prompt");
  await expect(prompt).toContainText("Return a reviewed implementation plan.");
  await page.getByRole("button", { name: "Save private prompt" }).click();
  await expect(
    page.getByText("Private prompt snapshot saved. No link was created and nothing was sent."),
  ).toBeVisible();
  await expect(page.getByText("{{artifact:")).toHaveCount(0);
});
