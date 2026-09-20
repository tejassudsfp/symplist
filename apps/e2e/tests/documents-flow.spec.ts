import { expect, test } from "@playwright/test";
import {
  documentHistoryResponseSchema,
  documentPublishResponseSchema,
  taskCreateResponseSchema,
} from "@symplist/contracts";
import { ownerApi } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

async function createTask(context: Parameters<typeof ownerApi>[0], title: string) {
  const api = await ownerApi(context);
  const created = await api.post("/tasks", { title, collection: "now" });
  expect(created.status(), await created.text()).toBe(201);
  return { api, task: taskCreateResponseSchema.parse(await created.json()).task };
}

test("edits and saves a page, compares history, and restores an older revision as a new commit", async ({
  context,
  page,
}) => {
  await signIn(context);
  const { api, task } = await createTask(context, "Document history journey");
  await page.goto(`/now/${task.id}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await expect(editor).toBeVisible();

  const first = "# Launch plan\n\nFirst reviewed version.\n";
  await editor.fill(first);
  await editor.press("ControlOrMeta+s");
  await expect(page.locator('[data-slot="document-pane"] [data-state="saved"]')).toBeVisible();

  const second = "# Launch plan\n\nSecond reviewed version with a checklist.\n\n- Ship calmly\n";
  await editor.fill(second);
  await editor.press("ControlOrMeta+s");
  await expect(page.locator('[data-slot="document-pane"] [data-state="saved"]')).toBeVisible();

  const before = documentHistoryResponseSchema.parse(
    await (await api.get(`/tasks/${task.id}/document/history?limit=10`)).json(),
  );
  expect(before.items).toHaveLength(2);

  await page.getByRole("link", { name: "Document history", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Document history" })).toBeVisible();
  const revisions = page.locator(".sym-doc-revision");
  await expect(revisions).toHaveCount(2);
  await revisions.last().click();
  await expect(page.locator('[data-slot="revision-preview"]')).toContainText(
    "First reviewed version.",
  );
  const comparison = page.locator('[data-slot="compare-view"]');
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText(/Added:|Removed:/).first()).toBeVisible();

  await page.getByRole("button", { name: "Restore this version", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Restore this version?" });
  await confirm.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator('[data-slot="restored"]')).toContainText(
    "every earlier revision is kept",
  );

  const head = await api.get(`/tasks/${task.id}/document`);
  expect(head.status(), await head.text()).toBe(200);
  expect((await head.json()) as { markdown: string }).toMatchObject({ markdown: first });
  const after = documentHistoryResponseSchema.parse(
    await (await api.get(`/tasks/${task.id}/document/history?limit=10`)).json(),
  );
  expect(after.items).toHaveLength(3);
  expect(after.items[0]?.kind).toBe("restore");
});

test("a concurrent page edit opens conflict review and Keep editing preserves the exact draft", async ({
  context,
  page,
}) => {
  await signIn(context);
  const { api, task } = await createTask(context, "Document conflict journey");
  const baseResponse = await api.post(`/tasks/${task.id}/document/commits`, {
    baseRevision: null,
    markdown: "# Shared section\n\nOriginal text.\n",
  });
  expect(baseResponse.status(), await baseResponse.text()).toBe(201);
  const base = documentPublishResponseSchema.parse(await baseResponse.json());

  await page.goto(`/now/${task.id}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const draft = "# Shared section\n\nMy unsaved draft marker.\n";
  await editor.fill(draft);

  const otherDevice = await api.post(`/tasks/${task.id}/document/commits`, {
    baseRevision: base.revision,
    markdown: "# Shared section\n\nSaved by another device.\n",
  });
  expect(otherDevice.status(), await otherDevice.text()).toBe(201);
  await editor.press("ControlOrMeta+s");

  const review = page.locator('[data-slot="conflict-review"]');
  await expect(
    review.getByRole("heading", { name: "This page changed while you were editing" }),
  ).toBeVisible();
  await expect(review).toContainText("My unsaved draft marker.");
  await expect(review).toContainText("Saved by another device.");
  await review.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(review).toBeHidden();
  await expect(editor).toContainText("My unsaved draft marker.");

  await page.reload();
  const restoredReview = page.locator('[data-slot="conflict-review"]');
  await expect(restoredReview).toContainText("My unsaved draft marker.");
  await expect(restoredReview).toContainText("Nothing you wrote was overwritten");
});
