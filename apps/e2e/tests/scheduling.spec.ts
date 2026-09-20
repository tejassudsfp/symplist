import { expect, test } from "@playwright/test";
import { schedulingSnapshotSchema, taskCreateResponseSchema } from "@symplist/contracts";
import { expectNoAxeViolations } from "../src/helpers/index.ts";
import { ownerApi, runReminderScan } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

test.beforeEach(async ({ context, page }) => {
  await signIn(context);
  await page.goto("/now");
});

test("deadline reschedule becomes a notification that can be snoozed and completed", async ({
  context,
  page,
}, testInfo) => {
  const title = "Send the project outline";
  const add = page.getByLabel("Add task to Now");
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/v1/tasks"),
  );
  await add.fill(title);
  await add.press("Enter");
  const createdResponse = await created;
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const { task } = taskCreateResponseSchema.parse(await createdResponse.json());
  const row = page
    .getByRole("treeitem", { name: new RegExp(title) })
    .and(page.locator(".sym-task-row"));
  await expect(row).toBeVisible();
  await row.hover();
  await page.getByRole("button", { name: `Task menu for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Deadline…" }).click();
  const editor = page.getByRole("dialog", { name: "Deadline and reminders" });
  await editor.getByLabel("Deadline date", { exact: true }).fill("2030-04-17");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toBeHidden();
  await page.goto("/calendar?date=2030-04-17&view=agenda");
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expectNoAxeViolations(page, testInfo);
  await page.getByRole("button", { name: "Change date" }).click();
  await editor.getByLabel("Deadline date", { exact: true }).fill("2030-04-18");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("No deadlines in this range. Dates are optional.")).toBeVisible();
  await page.goto("/calendar?date=2030-04-18&view=agenda");
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  const api = await ownerApi(context);
  const currentResponse = await api.get(`/tasks/${task.id}/schedule`);
  expect(currentResponse.status(), await currentResponse.text()).toBe(200);
  const current = schedulingSnapshotSchema.parse(await currentResponse.json());
  const due = new Date(Date.now() + 2 * 3_600_000);
  due.setUTCMinutes(0, 0, 0);
  const save = await api.put(`/tasks/${task.id}/schedule`, {
    baseVersion: current.version,
    deadline: current.deadline,
    reminders: [
      {
        rule: {
          kind: "absolute",
          local: due.toISOString().slice(0, 16),
          zone: "UTC",
          disambiguation: "reject",
        },
        channels: ["in_app"],
        overrideQuiet: false,
      },
    ],
  });
  expect(save.status(), await save.text()).toBe(200);
  expect(await runReminderScan(due.getTime() + 1_000)).toEqual({
    occurrenceCount: 1,
    acceptedCount: 0,
  });

  await page.goto("/now");
  await expect(page.getByRole("tree").getByText(title, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  const center = page.getByRole("dialog", { name: "Notifications", exact: true });
  const reminder = center.getByRole("article").filter({ hasText: title });
  await expect(reminder).toContainText("Deadline: 2030-04-18");
  await reminder.getByRole("button", { name: "Snooze", exact: true }).click();
  const snooze = page.getByRole("dialog", { name: "Snooze reminder", exact: true });
  await snooze.getByRole("button", { name: "1 hour", exact: true }).click();
  await snooze.getByRole("button", { name: "Snooze", exact: true }).click();
  await expect(snooze).toBeHidden();
  const snoozed = schedulingSnapshotSchema.parse(
    await (await api.get(`/tasks/${task.id}/schedule`)).json(),
  );
  expect(snoozed.deadline).toEqual(current.deadline);
  expect(snoozed.reminders).toHaveLength(1);

  await reminder.getByRole("button", { name: "Mark complete", exact: true }).click();
  await expect(page.getByRole("tree").getByText(title, { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  const completed = page.getByRole("dialog", { name: "Notifications" }).getByRole("article");
  await expect(completed).toContainText("This task is completed or archived.");
  await expect(completed.getByRole("button", { name: "Mark complete" })).toBeDisabled();
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
