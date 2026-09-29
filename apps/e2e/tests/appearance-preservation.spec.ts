import { expect, test } from "@playwright/test";
import { taskCreateResponseSchema } from "@symplist/contracts";
import { ownerApi } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

test("appearance changes preserve an unsaved page draft", async ({ context, page }) => {
  await signIn(context);
  const api = await ownerApi(context);
  const created = await api.post("/tasks", { title: "Appearance preservation", collection: "now" });
  expect(created.status(), await created.text()).toBe(201);
  const task = taskCreateResponseSchema.parse(await created.json()).task;
  await page.goto(`/now/${task.id}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const draftSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && response.url().endsWith("/document/draft"),
  );
  await editor.fill("# Draft\n\nAppearance draft marker stays here.\n");
  await draftSaved;

  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: /Meadow/ }).check({ force: true });
  await page.getByRole("radio", { name: "Dark", exact: true }).check({ force: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "meadow");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.getByText("Saved to your account")).toBeVisible();

  await page.goto(`/now/${task.id}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(editor).toContainText("Appearance draft marker stays here.");
});
