import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { captureEvidence, type EvidenceName, expectNoAxeViolations } from "../src/helpers/index.ts";
import { signIn } from "../src/helpers/session.ts";

/** Frames kept with the repository, named by the design handoff convention (overall.md). */
const EVIDENCE_DIR = fileURLToPath(new URL("../evidence/labels/", import.meta.url));

function evidence(page: Page, testInfo: Parameters<typeof captureEvidence>[1], name: EvidenceName) {
  return captureEvidence(page, testInfo, name, { keepIn: EVIDENCE_DIR });
}

/**
 * Labels against a real api: making one, putting it on a task, filtering a list by it, and deleting it
 * (§2.1). Every test signs a fresh account in, so no test sees another's labels.
 */

function tree(page: Page) {
  return page.getByRole("tree", { name: "Now tasks" });
}

function row(page: Page, title: string) {
  return page
    .getByRole("treeitem", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    .and(page.locator(".sym-task-row"));
}

type Project = { readonly project: { readonly name: string } };

/**
 * Makes the list visible when a viewport keeps it behind a control. At laptop width the shell puts the
 * list in a drawer, and on a phone the list and a task page are separate views; a journey that goes on
 * to work in the list has to ask for it first, as a person would.
 */
async function revealList(page: Page, testInfo: Project) {
  if (testInfo.project.name === "desktop") return;
  const field = page.getByLabel(/^Add task to /);
  const appeared = await field
    .waitFor({ state: "visible", timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return;
  await page.getByRole("button", { name: "Show task list" }).click();
  await expect(field).toBeVisible();
}

/** Back to a collection, with its list on screen whatever the viewport does with it. */
async function openList(page: Page, testInfo: Project) {
  await page.goto("/now");
  await revealList(page, testInfo);
}

async function addTasks(page: Page, titles: readonly string[]) {
  const field = page.getByLabel("Add task to Now");
  for (const title of titles) {
    await field.fill(title);
    await field.press("Enter");
    await expect(tree(page).getByText(title, { exact: true })).toBeVisible();
  }
}

/** Makes a label in Settings and comes back to the list. */
async function addLabel(page: Page, name: string, colour: string) {
  await page.goto("/settings/labels");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("radio", { name: colour }).check();
  await page.getByRole("button", { name: "Add label" }).click();
  await expect(labelRow(page, name)).toBeVisible();
}

/** Puts a label on a task, or takes it off, through the row's own menu. */
async function toggleLabel(page: Page, testInfo: Project, title: string, name: string) {
  await row(page, title).hover();
  await page.getByRole("button", { name: `Task menu for ${title}` }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: /Labels…/ }).click();
  // The menu turns to its Labels page in place, keeping the trigger's own accessible name, so the
  // page is recognised by the one entry only it has.
  await expect(page.getByRole("menuitem", { name: "Manage labels…" })).toBeVisible();
  await page.getByRole("menuitemcheckbox", { name: new RegExp(name) }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  // Escape closes the list drawer with the menu on the viewports that have one.
  await revealList(page, testInfo);
}

/** A row of the labels list in Settings. The page's own section nav is a list of items too. */
function labelRow(page: Page, name: string) {
  return page.locator(".sym-label-rows").getByRole("listitem").filter({ hasText: name });
}

function filterChip(page: Page, name: string) {
  return page.locator(".sym-label-filter").getByRole("button", { name: new RegExp(`^${name}`) });
}

test.beforeEach(async ({ context, page }, testInfo) => {
  await signIn(context);
  await openList(page, testInfo);
  await expect(page.getByLabel("Add task to Now")).toBeVisible();
});

test.describe("labels", () => {
  test("makes a label, puts it on a task and filters the list by it", async ({
    page,
  }, testInfo) => {
    await addTasks(page, ["Send the project outline", "Book a bike tune-up"]);
    await addLabel(page, "Deep work", "Violet");
    await evidence(page, testInfo, { screen: "settings_labels", state: "one-label" });

    await openList(page, testInfo);
    await expect(filterChip(page, "Deep work")).toBeVisible();
    await toggleLabel(page, testInfo, "Send the project outline", "Deep work");

    // The chip is on the row, and the filter's count moved with it.
    await expect(row(page, "Send the project outline").getByText("Deep work")).toBeVisible();
    await expect(filterChip(page, "Deep work")).toHaveText(/Deep work\s*1/);
    await evidence(page, testInfo, { screen: "workspace_now", state: "labelled" });

    await filterChip(page, "Deep work").click();
    await expect(tree(page).getByText("Send the project outline", { exact: true })).toBeVisible();
    await expect(tree(page).getByText("Book a bike tune-up", { exact: true })).toBeHidden();
    await evidence(page, testInfo, { screen: "workspace_now", state: "label-filtered" });

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(tree(page).getByText("Book a bike tune-up", { exact: true })).toBeVisible();
  });

  test("keeps a label and its chips across a reload, and drops both on delete", async ({
    page,
  }, testInfo) => {
    await addTasks(page, ["Water the plants"]);
    await addLabel(page, "Errands", "Amber");
    await openList(page, testInfo);
    await toggleLabel(page, testInfo, "Water the plants", "Errands");
    await expect(row(page, "Water the plants").getByText("Errands")).toBeVisible();

    // A reload reads it back from the api, so nothing about it lived only in this tab.
    await page.reload();
    await revealList(page, testInfo);
    await expect(row(page, "Water the plants").getByText("Errands")).toBeVisible();

    await page.goto("/settings/labels");
    await expect(labelRow(page, "Errands")).toContainText("1 task");
    await page.getByRole("button", { name: "Delete Errands" }).click();
    await expect(labelRow(page, "Errands")).toBeHidden();
    // The toast appears only once the api has accepted the delete. Navigating on the optimistic
    // removal alone would cancel the request the page is still making.
    await expect(page.getByText(/Deleted “Errands”/)).toBeVisible();

    // The task is untouched apart from the chip that went with the label.
    await openList(page, testInfo);
    await expect(tree(page).getByText("Water the plants", { exact: true })).toBeVisible();
    await expect(row(page, "Water the plants").getByText("Errands")).toBeHidden();
    await expect(page.locator(".sym-label-filter")).toBeHidden();
  });

  test("refuses a second label with the same name, saying which one has it", async ({ page }) => {
    await addLabel(page, "Work", "Blue");
    await page.getByLabel("Name").fill("  work  ");
    await page.getByRole("button", { name: "Add label" }).click();
    // Scoped by its text: Next's own route announcer is a `role="alert"` region too.
    await expect(page.getByText("You already have a label with that name.")).toBeVisible();
    // What was typed stays, so the correction is one edit rather than a retype.
    await expect(page.getByLabel("Name")).toHaveValue("  work  ");
    await expect(page.locator(".sym-label-rows").getByRole("listitem")).toHaveCount(1);
  });

  test("passes axe WCAG 2.2 AA with labels on screen", async ({ page }, testInfo) => {
    await addTasks(page, ["Send the project outline"]);
    await addLabel(page, "Deep work", "Violet");
    await expectNoAxeViolations(page, testInfo, { label: "labels-settings" });
    await openList(page, testInfo);
    await toggleLabel(page, testInfo, "Send the project outline", "Deep work");
    await expect(row(page, "Send the project outline").getByText("Deep work")).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "labels-list" });
  });
});
