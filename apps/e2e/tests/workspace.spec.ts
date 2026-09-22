/// <reference lib="dom" />
// Callbacks passed to page.evaluate run in the browser, so this spec needs the DOM types.
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { captureEvidence, type EvidenceName, expectNoAxeViolations } from "../src/helpers/index.ts";
import { signIn } from "../src/helpers/session.ts";

/** Frames kept with the repository, named by the design handoff convention (overall.md). */
const EVIDENCE_DIR = fileURLToPath(new URL("../evidence/workspace/", import.meta.url));

function evidence(page: Page, testInfo: Parameters<typeof captureEvidence>[1], name: EvidenceName) {
  return captureEvidence(page, testInfo, name, { keepIn: EVIDENCE_DIR });
}

/**
 * The workspace against a real api (workspace_now.md, workspace_later.md, archive.md,
 * task_actions.md, settings_appearance.md, keyboard_shortcuts.md). Every test signs a fresh account
 * in, so no test sees another's tasks and the order they run in never matters.
 */

/** Adds tasks to a collection through the quick-add field, in order. */
async function addTasks(page: Page, collection: string, titles: readonly string[]) {
  const field = page.getByLabel(`Add task to ${collection}`);
  for (const title of titles) {
    await field.fill(title);
    await field.press("Enter");
    await expect(tree(page, collection).getByText(title, { exact: true })).toBeVisible();
  }
}

function tree(page: Page, collection: string) {
  return page.getByRole("tree", { name: `${collection} tasks` });
}

/**
 * A task's row. Scoped to `.sym-task-row` because the open subtask draft is a treeitem too, and its
 * accessible name names the parent it sits under.
 */
function row(page: Page, title: string) {
  return page
    .getByRole("treeitem", { name: new RegExp(escapeForRegExp(title)) })
    .and(page.locator(".sym-task-row"));
}

/**
 * A task's title inside the list. Text queries have to be scoped: the status announcer repeats what
 * just happened ("Added ... to Now") in a live region, which matches a bare text query too.
 */
function taskTitle(page: Page, title: string) {
  return page.getByRole("tree").getByText(title, { exact: true });
}

/**
 * Opens a task's menu. Its controls are `visibility: hidden` until the row is hovered, focused or
 * selected (workspace_now.md), so the pointer has to be on the row first.
 */
async function openTaskMenu(page: Page, title: string) {
  await row(page, title).hover();
  await page.getByRole("button", { name: `Task menu for ${title}` }).click();
  // The click resolves before the menu mounts. Without this a following keypress races the open --
  // Escape lands first, the menu appears after it, and it never closes.
  await expect(page.getByRole("menu")).toBeVisible();
}

/** Adds a subtask under the focused task from the keyboard, and waits for it in the list. */
async function addSubtask(page: Page, parent: string, title: string) {
  await row(page, parent).focus();
  await page.keyboard.press("Shift+N");
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await expect(taskTitle(page, title)).toBeVisible();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Makes the list visible when a viewport keeps it behind a control. At laptop width the shell puts
 * the list in a drawer once a task page is open, and on a phone the list and the page are separate
 * views; a journey that goes on to work in the list has to ask for it first, as a person would.
 */
async function revealList(page: Page, testInfo: { readonly project: { readonly name: string } }) {
  if (testInfo.project.name === "desktop") return;
  const field = page.getByLabel(/^Add task to /);
  // Give the layout time to settle first: on these viewports the list appears by itself on a
  // collection route, and the control that shows it is removed the moment it does — so asking too
  // early means clicking a button that is already on its way out.
  const appeared = await field
    .waitFor({ state: "visible", timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return;
  await page.getByRole("button", { name: "Show task list" }).click();
  await expect(field).toBeVisible();
}

/** The order of the top-level tasks in a collection, as the tree shows them. */
async function titles(page: Page, collection: string): Promise<string[]> {
  return tree(page, collection)
    .locator(".sym-task-row")
    .evaluateAll((rows) =>
      rows.map((element) =>
        (element.querySelector(".sym-task-title")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    );
}

test.beforeEach(async ({ context, page }) => {
  await signIn(context);
  await page.goto("/now");
  await expect(page.getByLabel("Add task to Now")).toBeVisible();
});

test.describe("the workspace", () => {
  test("captures a task, opens it, and keeps its page and chat together", async ({
    page,
  }, testInfo) => {
    await addTasks(page, "Now", ["Refresh my portfolio", "Send the project outline"]);
    // The quick-add field is never blocked by the list's own state: it is ready before the tasks are.
    await expect(page.getByLabel("Add task to Now")).toHaveValue("");

    await taskTitle(page, "Send the project outline").click();
    await expect(page).toHaveURL(/\/now\/[0-9a-f-]{36}$/);
    if (testInfo.project.name !== "mobile") {
      // The page frame's header names the task, and the chat beside it names the same one.
      await expect(
        page.getByRole("heading", { level: 1, name: "Send the project outline" }),
      ).toBeVisible();
      await expect(
        page.getByRole("complementary", { name: "Simon" }).getByText("Send the project outline"),
      ).toBeVisible();
    }
    await evidence(page, testInfo, { screen: "workspace_now", state: "task-open" });
  });

  test("completes a task, finds it in the archive and restores it", async ({ page }, testInfo) => {
    await addTasks(page, "Now", ["Book a bike tune-up", "Water the plants"]);

    await page.getByRole("checkbox", { name: "Complete Book a bike tune-up" }).click();
    await expect(taskTitle(page, "Book a bike tune-up")).toBeHidden();
    await expect(page.getByText(/Completed “Book a bike tune-up”/)).toBeVisible();
    await evidence(page, testInfo, { screen: "workspace_now", state: "completed-undo" });

    await page.goto("/archive");
    const record = page.getByRole("link", { name: /Book a bike tune-up/ });
    await expect(record).toBeVisible();
    await record.click();
    const detail = page.getByRole("region", { name: "Archived task" });
    await expect(detail.getByRole("heading", { name: "Book a bike tune-up" })).toBeVisible();
    await evidence(page, testInfo, { screen: "archive", state: "record-open" });

    await detail.getByRole("button", { name: "Restore" }).click();
    await expect(detail.getByText(/Restored to Now/)).toBeVisible();

    await page.goto("/now");
    await expect(row(page, "Book a bike tune-up")).toBeVisible();
  });

  test("takes back a completion with Undo, without a reload", async ({ page }) => {
    await addTasks(page, "Now", ["Send the project outline"]);
    await page.getByRole("checkbox", { name: "Complete Send the project outline" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(row(page, "Send the project outline")).toBeVisible();

    // The server agrees, not just this browser.
    await page.reload();
    await expect(row(page, "Send the project outline")).toBeVisible();
  });

  test("moves a task from Now to Later and back with Undo", async ({ page }, testInfo) => {
    await addTasks(page, "Now", ["Plan a quiet weekend", "Send the project outline"]);

    await openTaskMenu(page, "Plan a quiet weekend");
    await page.getByRole("menuitem", { name: /Move to…/ }).click();
    await page.getByRole("menuitem", { name: "Later", exact: true }).click();
    await expect(page.getByText(/Moved “Plan a quiet weekend” to Later/)).toBeVisible();
    await expect(row(page, "Plan a quiet weekend")).toBeHidden();

    await page.getByRole("link", { name: "Later" }).click();
    await revealList(page, testInfo);
    await expect(row(page, "Plan a quiet weekend")).toBeVisible();
    await evidence(page, testInfo, { screen: "workspace_later", state: "moved-in" });

    await page.goto("/now");
    await revealList(page, testInfo);
    await addTasks(page, "Now", ["Book a bike tune-up"]);
    await openTaskMenu(page, "Book a bike tune-up");
    await page.getByRole("menuitem", { name: /Move to…/ }).click();
    await page.getByRole("menuitem", { name: "Unclassified", exact: true }).click();
    await expect(page.getByText(/Moved “Book a bike tune-up” to Unclassified/)).toBeVisible();
    await expect(row(page, "Book a bike tune-up")).toBeHidden();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText(/Moved “Book a bike tune-up” back to Now/)).toBeVisible();
    // At laptop width the list is a drawer, and pressing Undo in the toast is a press outside it,
    // which closes it — so the list is asked for again before it is read.
    await revealList(page, testInfo);
    await expect(row(page, "Book a bike tune-up")).toBeVisible();
  });

  test("Enter adds and selects; Shift+Enter adds and stays for the next one", async ({ page }) => {
    const field = page.getByLabel("Add task to Now");

    // Shift+Enter keeps the caret in the field, so a run of tasks is typed without reaching back.
    await field.fill("Water the plants");
    await field.press("Shift+Enter");
    await expect(row(page, "Water the plants")).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("");

    await page.keyboard.type("Buy stamps");
    await field.press("Shift+Enter");
    await expect(row(page, "Buy stamps")).toBeVisible();
    await expect(field).toBeFocused();

    // Plain Enter finishes: focus lands on the task just made, ready for the next keystroke.
    await page.keyboard.type("Book the train");
    await field.press("Enter");
    await expect(row(page, "Book the train")).toBeFocused();
    await expect(field).toHaveValue("");
  });

  test("runs the whole list from the keyboard, with no pointer at all", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "note 13 shortcuts are a pointer-free desktop path",
    );
    await addTasks(page, "Now", ["Refresh my portfolio", "Send the project outline"]);

    // `n` from anywhere in the list pane puts the caret in quick add.
    await row(page, "Refresh my portfolio").focus();
    await page.keyboard.press("n");
    await expect(page.getByLabel("Add task to Now")).toBeFocused();
    await page.keyboard.type("Water the plants");
    await page.keyboard.press("Enter");
    await expect(row(page, "Water the plants")).toBeVisible();

    // A subtask under the focused task, then `j`/`k` through what is on screen.
    await addSubtask(page, "Refresh my portfolio", "Pick five projects");

    await row(page, "Refresh my portfolio").focus();
    await page.keyboard.press("j");
    await expect(row(page, "Pick five projects")).toBeFocused();

    // Rename in place, then complete, entirely from the keyboard.
    await page.keyboard.press("r");
    const rename = page.getByLabel("Rename Pick five projects");
    await expect(rename).toBeFocused();
    await rename.fill("Pick five favourites");
    await rename.press("Enter");
    await expect(taskTitle(page, "Pick five favourites")).toBeVisible();

    await row(page, "Water the plants").focus();
    await page.keyboard.press("x");
    await expect(row(page, "Water the plants")).toBeHidden();
    await evidence(page, testInfo, { screen: "keyboard_shortcuts", state: "list-journey" });
  });

  test("changes appearance and keeps it, without touching the list", async ({ page }, testInfo) => {
    await addTasks(page, "Now", ["Refresh my portfolio"]);

    await page.goto("/settings/appearance");
    await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
    // The radios are visually hidden inside their cards, so the card itself is what is clicked.
    await page.getByRole("radio", { name: /Meadow/ }).check({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "meadow");
    await page.getByRole("radio", { name: "Dark", exact: true }).check({ force: true });
    await expect(page.getByText("Saved to your account")).toBeVisible();
    await evidence(page, testInfo, {
      screen: "settings_appearance",
      state: "meadow-chosen",
      theme: "meadow",
      mode: "dark",
    });

    // Settings is not a collection, so the shell shows it on its own rather than beside the list.
    await expect(page.getByLabel("Add task to Now")).toBeHidden();

    // The account keeps the choice across a fresh load, and the list is intact.
    await page.goto("/now");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "meadow");
    await expect(taskTitle(page, "Refresh my portfolio")).toBeVisible();
  });

  test("remaps a shortcut and shows the new key in the menu that runs it", async ({ page }) => {
    await addTasks(page, "Now", ["Refresh my portfolio"]);
    await page.goto("/settings/shortcuts");
    await expect(page.getByLabel("Search shortcuts")).toBeVisible();

    await page.getByLabel("Search shortcuts").fill("Rename");
    const renameRow = page.getByRole("listitem").filter({ hasText: "Rename task" }).first();
    await renameRow.getByRole("button", { name: "Change" }).click();
    // Use a chord that is safe on every platform. Control is `Mod` on Linux/Windows, where
    // Control+Shift+R is the browser's hard-reload shortcut and must be rejected by the app.
    await page.keyboard.press("Alt+Shift+R");
    await expect(renameRow).toContainText(/⌥⇧R|Alt\+Shift\+R/i);
    await expect(renameRow.getByText("Previewing here")).toBeHidden();
    await expect(page.getByText("Saved to your account")).toBeVisible();

    // The task menu shows the account's key, because the menu and the shortcut are one action.
    await page.goto("/now");
    await expect(taskTitle(page, "Refresh my portfolio")).toBeVisible();
    await openTaskMenu(page, "Refresh my portfolio");
    const item = page.getByRole("menuitem", { name: /Rename/ });
    await expect(item).toContainText(/⌥⇧R|Alt\+Shift\+R/i);
  });

  test("passes axe WCAG 2.2 AA with a populated list", async ({ page }, testInfo) => {
    await addTasks(page, "Now", ["Refresh my portfolio", "Send the project outline"]);
    await addSubtask(page, "Refresh my portfolio", "Pick five projects");
    await expectNoAxeViolations(page, testInfo, { label: "workspace-now" });
    await evidence(page, testInfo, { screen: "workspace_now", state: "populated" });

    await page.goto("/archive");
    await expect(page.getByRole("heading", { level: 1, name: "Archive" })).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "archive-empty" });

    await page.goto("/settings/appearance");
    await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "settings-appearance" });

    await page.goto("/settings/shortcuts");
    await expect(page.getByLabel("Search shortcuts")).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "settings-shortcuts" });
  });

  test("keeps a valid tree for a screen reader, at every level", async ({ page }) => {
    await addTasks(page, "Now", ["Refresh my portfolio", "Send the project outline"]);
    for (const title of ["Pick five projects", "Rewrite the about page"]) {
      await addSubtask(page, "Refresh my portfolio", title);
    }

    // Only the task rows: the still-open subtask draft is a treeitem of its own, deliberately with
    // an unknown set size, because it is not part of the set until it is saved.
    const described = await tree(page, "Now")
      .locator(".sym-task-row")
      .evaluateAll((rows) =>
        rows.map((element) =>
          [
            element.getAttribute("aria-level"),
            element.getAttribute("aria-posinset"),
            element.getAttribute("aria-setsize"),
          ].join("/"),
        ),
      );
    // Two top-level tasks, each 'n of 2', and two subtasks each 'n of 2' *within their parent* —
    // not their place in the flat list of rows on screen.
    expect(described).toEqual(["1/1/2", "2/1/2", "2/2/2", "1/2/2"]);
    expect(await titles(page, "Now")).toEqual([
      "Refresh my portfolio",
      "Pick five projects",
      "Rewrite the about page",
      "Send the project outline",
    ]);
  });

  test("raises no CSP violation while the workspace runs", async ({ page }) => {
    await page.evaluate(() => {
      const store: string[] = [];
      (window as unknown as { __violations: string[] }).__violations = store;
      document.addEventListener("securitypolicyviolation", (event) => {
        store.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
    });
    await addTasks(page, "Now", ["Refresh my portfolio"]);
    await openTaskMenu(page, "Refresh my portfolio");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    const violations = await page.evaluate(
      () => (window as unknown as { __violations: string[] }).__violations,
    );
    // The drag library injects a stylesheet and the contracts schemas parse in the browser; both
    // have to stay inside the strict CSP (decision W1).
    expect(violations).toEqual([]);
  });
});
