import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "../src/helpers/index.ts";
import { signIn } from "../src/helpers/session.ts";

test.beforeEach(async ({ context, page }) => {
  await signIn(context);
  await page.goto("/now");
});

test("task deadline persists into calendar and can be cleared without moving the task", async ({
  page,
}, testInfo) => {
  const title = "Send the project outline";
  const add = page.getByLabel("Add task to Now");
  await add.fill(title);
  await add.press("Enter");
  const row = page
    .getByRole("treeitem", { name: new RegExp(title) })
    .and(page.locator(".sym-task-row"));
  await expect(row).toBeVisible();
  await row.hover();
  await page.getByRole("button", { name: `Task menu for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Deadline…" }).click();
  const editor = page.getByRole("dialog", { name: "Deadline and reminders" });
  await editor.getByLabel("Deadline date", { exact: true }).fill("2027-04-17");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toBeHidden();
  await page.goto("/calendar?date=2027-04-17&view=agenda");
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expectNoAxeViolations(page, testInfo);
  await page.getByRole("button", { name: "Change date" }).click();
  await editor.getByRole("button", { name: "Clear deadline" }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("No deadlines in this range. Dates are optional.")).toBeVisible();
  await page.goto("/now");
  await expect(page.getByRole("tree").getByText(title, { exact: true })).toBeVisible();
});

test("notification center is empty and settings preserve channel choice after reload", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByRole("heading", { name: "All quiet here" })).toBeVisible();
  await page.getByRole("link", { name: "Notification settings" }).click();
  await page.getByLabel("Timezone", { exact: true }).fill("Asia/Kathmandu");
  await page.getByLabel("Reminder email", { exact: true }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Notification settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("Asia/Kathmandu");
  await expect(page.getByLabel("Reminder email", { exact: true })).toBeChecked();
  await expectNoAxeViolations(page, testInfo);
});
