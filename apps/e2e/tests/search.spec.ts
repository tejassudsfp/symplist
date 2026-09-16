/// <reference lib="dom" />
// Callbacks passed to page.evaluate run in the browser, so this spec needs the DOM types.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type Route, type TestInfo, test } from "@playwright/test";

/*
 * Search end to end (note 14, search.md, command_palette.md, keyboard_shortcuts.md): the palette's
 * keyboard-only sequence, full search with the archive opt-in and opening a result, and the shortcut
 * help overlay with focus restored.
 *
 * The api answers from contract-shaped fixtures served through request interception: signing in
 * (access) and creating tasks (workspace) are other features' flows, and this spec must not depend on
 * them. Every response here is exactly what `@symplist/contracts` defines, and the app validates each
 * one before rendering, so a drifting contract fails the test.
 */

const evidenceDir = fileURLToPath(new URL("../evidence/search/", import.meta.url));
mkdirSync(evidenceDir, { recursive: true });

type ProjectName = "desktop" | "laptop" | "mobile";

function project(testInfo: TestInfo): ProjectName {
  return testInfo.project.name as ProjectName;
}

async function evidence(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: `${evidenceDir}${project(testInfo)}-${name}.png`,
    animations: "disabled",
  });
}

const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}

/* ------------------------------------------------------------------------------------------------
 * Fixtures (the Maya dataset from design/mockups/overall.md)
 * --------------------------------------------------------------------------------------------- */

const fixtureId = (sequence: number) =>
  `0192f0a0-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;

interface FixtureTask {
  readonly id: string;
  readonly title: string;
  readonly collection: string;
  readonly parent?: { readonly id: string; readonly title: string };
  readonly archived?: boolean;
}

const task = (fixture: FixtureTask): FixtureTask => fixture;

const tasks = {
  portfolio: task({ id: fixtureId(0x101), title: "Refresh my portfolio", collection: "now" }),
  projects: task({
    id: fixtureId(0x102),
    title: "Pick five projects to feature",
    collection: "now",
    parent: { id: fixtureId(0x101), title: "Refresh my portfolio" },
  }),
  outline: task({ id: fixtureId(0x104), title: "Send the project outline", collection: "now" }),
  photos: task({
    id: fixtureId(0x402),
    title: "Choose portfolio photos",
    collection: "now",
    archived: true,
  }),
};

function summary(task: FixtureTask, titleHighlights: { start: number; end: number }[] = []) {
  return {
    id: task.id,
    title: task.title,
    titleHighlights,
    collection: task.collection,
    archived: task.archived === true,
    parent: task.parent ?? null,
    updatedAt: 1_756_724_400_000,
  };
}

function group(task: FixtureTask, extra: Record<string, unknown> = {}) {
  const start = task.title.toLowerCase().indexOf("portfolio");
  return {
    task: summary(task, start >= 0 ? [{ start, end: start + "portfolio".length }] : []),
    match: "body",
    matchedAllTerms: true,
    titleStale: false,
    sections: [],
    sectionCount: 0,
    messages: [],
    messageCount: 0,
    ...extra,
  };
}

const projectsSection = {
  sectionId: "sec-projects-to-feature",
  ordinal: 2,
  heading: "Projects to feature",
  headingHighlights: [],
  match: "body",
  snippet: {
    text: "Field notes app — the one people actually ask about",
    highlights: [{ start: 0, end: 5 }],
    truncatedStart: false,
    truncatedEnd: true,
  },
  indexedRevision: "rev-12",
  currentRevision: "rev-12",
  stale: false,
};

const freshness = { status: "ready", indexGeneration: 7, pendingIntents: 0 };

function titleResponse(items: FixtureTask[], query: string) {
  return {
    ...freshness,
    items: items.map((task) => {
      const start = task.title.toLowerCase().indexOf(query.toLowerCase());
      return {
        task: summary(task, start >= 0 ? [{ start, end: start + query.length }] : []),
        match: start === 0 ? "title_exact" : "title_prefix",
        titleStale: false,
      };
    }),
  };
}

function contentResponse(archive: string) {
  const items = [
    group(tasks.portfolio, { sections: [projectsSection], sectionCount: 3, match: "body" }),
    group(tasks.outline, { match: "title_terms" }),
  ];
  if (archive !== "exclude") items.push(group(tasks.photos, { match: "title_terms" }));
  return {
    ...freshness,
    scope: {
      collections: ["now", "later", "unclassified"],
      archive,
      types: ["tasks", "documents"],
      taskId: null,
      deadline: null,
    },
    notices: [],
    items: archive === "only" ? [group(tasks.photos, { match: "title_terms" })] : items,
    nextCursor: null,
  };
}

/** Serves the search feature's endpoints from fixtures, with the CORS headers the browser needs. */
async function stubApi(page: Page) {
  const seen: string[] = [];
  await page.route("**/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const origin = route.request().headers().origin ?? "*";
    seen.push(`${url.pathname}${url.search}`);
    const send = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
        },
        body: JSON.stringify(body),
      });
    if (url.pathname === "/v1/preferences/recent") {
      return send({
        group: "recent",
        version: 3,
        data: { taskIds: [tasks.projects.id, tasks.outline.id] },
        updatedAt: 1_756_724_400_000,
      });
    }
    if (url.pathname.startsWith("/v1/tasks/")) {
      const id = url.pathname.split("/").at(-1);
      const found = Object.values(tasks).find((entry) => entry.id === id);
      if (!found) {
        return send({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
      }
      return send({
        task: {
          id: found.id,
          parentId: found.parent ? found.parent.id : null,
          collection: found.collection,
          status: found.archived ? "archived" : "active",
          title: found.title,
          version: 2,
        },
        ancestors: found.parent ? [found.parent] : [],
      });
    }
    if (url.pathname === "/v1/search/titles") {
      const query = url.searchParams.get("q") ?? "";
      const matches = Object.values(tasks).filter(
        (entry) => !entry.archived && entry.title.toLowerCase().includes(query.toLowerCase()),
      );
      return send(titleResponse(matches, query));
    }
    if (url.pathname === "/v1/search/freshness") return send(freshness);
    if (url.pathname === "/v1/search") {
      return send(contentResponse(url.searchParams.get("archive") ?? "exclude"));
    }
    return send({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  });
  return seen;
}

/**
 * On a phone the filters sit behind a disclosure. Right after a back navigation the previous page's
 * DOM can still be on screen, so the disclosure is retried until the filters are really showing.
 */
async function showFilters(page: Page, testInfo: TestInfo) {
  if (project(testInfo) !== "mobile") return;
  await expect(async () => {
    const filters = page.getByRole("button", { name: "Filters" });
    if ((await filters.getAttribute("aria-expanded")) !== "true") await filters.click();
    await expect(page.getByRole("radio", { name: "Active and archived" })).toBeVisible({
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
}

async function openApp(page: Page, path: string) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-theme", /.+/);
  if (path.startsWith("/search")) {
    // The search screen takes focus on arrival, which only happens once it is hydrated (note 14).
    await expect(
      page.getByRole("searchbox", { name: "Search tasks, documents and chat" }),
    ).toBeFocused();
  } else {
    // Wait for hydration: the keyboard dispatcher attaches on the client.
    await page.waitForFunction(() => document.querySelector("[data-group]") !== null);
  }
  expect(failures, `the page raised ${failures.join("; ")}`).toEqual([]);
}

/* ------------------------------------------------------------------------------------------------
 * The command palette
 * --------------------------------------------------------------------------------------------- */

test.describe("the command palette", () => {
  test("opens with Mod+K, finds a task, opens it and runs an action", async ({
    page,
  }, testInfo) => {
    const requests = await stubApi(page);
    await openApp(page, "/now");
    const body = page.locator("body");
    await body.click({ position: { x: 5, y: 300 } });

    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByRole("combobox", { name: "Search tasks" });
    await expect(input).toBeFocused();
    // The empty query shows recent tasks from preferences, with their collection and breadcrumb.
    await expect(page.getByRole("option", { name: /Pick five projects to feature/ })).toBeVisible();
    await expect(page.getByText("in “Refresh my portfolio”")).toBeVisible();
    await evidence(page, testInfo, "palette-recent");
    await expectNoAxeViolations(page);

    await page.keyboard.type("portfolio");
    const match = page.getByRole("option", { name: /Refresh my portfolio/ });
    await expect(match).toBeVisible();
    await expect(match.locator("mark")).toHaveText("portfolio");
    await evidence(page, testInfo, "palette-results");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/now/${tasks.portfolio.id}$`));
    await expect(page.getByRole("combobox", { name: "Search tasks" })).toHaveCount(0);

    // Reopen and run an action: the palette and the shortcut show the same registry (note 13).
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: "Search tasks" })).toBeFocused();
    await page.keyboard.type(">chat");
    const action = page.getByRole("option", { name: /Open Simon chat/ });
    await expect(action).toBeVisible();
    await expect(action).toContainText("Navigation");
    await evidence(page, testInfo, "palette-actions");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Simon" })).toBeVisible();

    expect(requests.some((path) => path.startsWith("/v1/search/titles?q=portfolio"))).toBe(true);
    // The query never reaches the address bar (note 14).
    expect(new URL(page.url()).search).toBe("");
  });

  test("shows a disabled action's reason instead of running it", async ({ page }) => {
    await stubApi(page);
    await openApp(page, "/now");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: "Search tasks" })).toBeFocused();
    await page.keyboard.type(">page");
    const action = page.getByRole("option", { name: /Open task page/ });
    await expect(action).toContainText("Open a task first");
    await expect(action).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox")).toBeVisible();
    await expect(page).toHaveURL(/\/now$/);
  });

  test("closes with Escape and gives focus back", async ({ page }) => {
    await stubApi(page);
    await openApp(page, "/now");
    const vault = page.getByRole("link", { name: "Vault" });
    await vault.focus();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(vault).toBeFocused();
  });

  test("fills the screen on a phone with a visible way back", async ({ page }, testInfo) => {
    test.skip(project(testInfo) !== "mobile", "The full-height surface is the phone layout.");
    await stubApi(page);
    await openApp(page, "/now");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box?.height).toBeGreaterThan((viewport?.height ?? 0) * 0.9);
    await evidence(page, testInfo, "palette-mobile");
    await page.getByRole("button", { name: "Close search" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Full search
 * --------------------------------------------------------------------------------------------- */

test.describe("full search", () => {
  test("searches everything, opts into the archive and opens a result", async ({
    page,
  }, testInfo) => {
    const requests = await stubApi(page);
    await openApp(page, "/now");
    await page.locator("body").click({ position: { x: 5, y: 300 } });

    // The palette hands its query to the richer surface.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: "Search tasks" })).toBeFocused();
    await page.keyboard.type("portfolio");
    await page.getByRole("option", { name: /Search all content/ }).click();
    await expect(page).toHaveURL(/\/search$/);

    const query = page.getByRole("searchbox", { name: "Search tasks, documents and chat" });
    await expect(query).toHaveValue("portfolio");
    await expect(
      page.getByText(/Task titles and documents in Now, Later and Unclassified/),
    ).toBeVisible();
    const groups = page.getByRole("article");
    await expect(groups).toHaveCount(2);
    await expect(groups.first().getByRole("heading", { level: 2 })).toContainText(
      "Refresh my portfolio",
    );
    await expect(page.getByText("Projects to feature")).toBeVisible();
    await expect(page.getByText(/notes app/)).toBeVisible();
    await evidence(page, testInfo, "results");
    await expectNoAxeViolations(page);

    // Archive is opt-in and visibly marked (note 14).
    await showFilters(page, testInfo);
    await page.getByRole("radio", { name: "Active and archived" }).click();
    await expect(page.getByRole("article")).toHaveCount(3);
    const archived = page.getByRole("article").filter({ hasText: "Choose portfolio photos" });
    await expect(archived.getByText("Archived")).toBeVisible();
    await expect(page.getByText(/Archived tasks are included/)).toBeVisible();
    await evidence(page, testInfo, "results-archive");
    expect(requests.some((path) => path.includes("archive=include"))).toBe(true);

    // Opening a section hit opens its task at that section.
    await page.getByRole("link", { name: /Projects to feature/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/now/${tasks.portfolio.id}\\?section=sec-projects-to-feature$`),
    );
    await evidence(page, testInfo, "opened-task");

    // Coming back keeps the query and the filter (search.md).
    await page.goBack();
    await expect(page).toHaveURL(/\/search$/);
    await expect(
      page.getByRole("searchbox", { name: "Search tasks, documents and chat" }),
    ).toHaveValue("portfolio");
    // The restored page can replace the one the back navigation left on screen, so the disclosure
    // and the filter are checked together until they agree.
    await expect(async () => {
      await showFilters(page, testInfo);
      await expect(page.getByRole("radio", { name: "Active and archived" })).toBeChecked({
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await expect(page.getByRole("article")).toHaveCount(3);
  });

  test("moves through results with the keyboard", async ({ page }, testInfo) => {
    test.skip(project(testInfo) === "mobile", "Hardware keyboard flows run at the larger widths.");
    await stubApi(page);
    await openApp(page, "/search");
    const query = page.getByRole("searchbox", { name: "Search tasks, documents and chat" });
    await expect(query).toBeFocused();
    await page.keyboard.type("portfolio");
    await expect(page.getByRole("article").first()).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("link", { name: /Refresh my portfolio/ })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(query).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(query).toHaveValue("");
    await expect(page.getByText("Search your work")).toBeVisible();
  });

  test("tells no matches, a failure and a rebuilding index apart", async ({ page }, testInfo) => {
    let mode: "empty" | "failure" | "rebuilding" = "empty";
    await page.route("**/v1/**", async (route: Route) => {
      const url = new URL(route.request().url());
      const origin = route.request().headers().origin ?? "*";
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
      };
      if (url.pathname !== "/v1/search") {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          headers,
          body: JSON.stringify({ error: { code: "not_found", message: "no", requestId: "r" } }),
        });
      }
      if (mode === "failure") {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          headers,
          body: JSON.stringify({
            error: { code: "search.unavailable", message: "unavailable", requestId: "r" },
          }),
        });
      }
      const body = {
        status: mode === "rebuilding" ? "rebuilding" : "ready",
        indexGeneration: mode === "rebuilding" ? 0 : 7,
        pendingIntents: mode === "rebuilding" ? 4 : 0,
        scope: {
          collections: ["now", "later", "unclassified"],
          archive: "exclude",
          types: ["tasks", "documents"],
          taskId: null,
          deadline: null,
        },
        notices: mode === "rebuilding" ? ["changes_pending"] : [],
        items: [],
        nextCursor: null,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });
    });
    await openApp(page, "/search");

    // The empty query prompts instead of showing a query history (note 14).
    await expect(page.getByText("Search your work")).toBeVisible();
    await evidence(page, testInfo, "empty-query");

    await page.getByRole("searchbox", { name: "Search tasks, documents and chat" }).fill("kayak");
    // The message is both shown and announced, so the visible one is asserted.
    await expect(page.getByText("No results for “kayak”").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Include archived" })).toBeVisible();
    await evidence(page, testInfo, "no-matches");

    mode = "failure";
    await page
      .getByRole("searchbox", { name: "Search tasks, documents and chat" })
      .fill("kayaking");
    await expect(page.getByText("Search is temporarily unavailable").first()).toBeVisible();
    await evidence(page, testInfo, "failure");

    mode = "rebuilding";
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(/Search is rebuilding its index/)).toBeVisible();
    await expect(page.getByText("Some recent changes aren't searchable yet.")).toBeVisible();
    await evidence(page, testInfo, "rebuilding");
    await expectNoAxeViolations(page);
  });

  test("keeps contrast and focus in dark mode", async ({ page, context, baseURL }, testInfo) => {
    test.skip(project(testInfo) !== "desktop", "One brightness check is enough per theme system.");
    await stubApi(page);
    await context.addCookies([
      { name: "sym_appearance", value: "v1.studio.dark.violet", url: baseURL ?? "" },
    ]);
    await openApp(page, "/search");
    await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
    await page.keyboard.type("portfolio");
    await expect(page.getByRole("article").first()).toBeVisible();
    await evidence(page, testInfo, "results-dark");
    await expectNoAxeViolations(page);
  });
});

/* ------------------------------------------------------------------------------------------------
 * The shortcut help overlay
 * --------------------------------------------------------------------------------------------- */

test.describe("the shortcut help overlay", () => {
  test("opens with ?, searches the live registry and restores focus", async ({
    page,
  }, testInfo) => {
    test.skip(
      project(testInfo) === "mobile",
      "`?` needs a hardware keyboard; the menu covers touch.",
    );
    await stubApi(page);
    await openApp(page, "/now");
    const vault = page.getByRole("link", { name: "Vault" });
    await vault.focus();
    await page.keyboard.press("?");

    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { level: 3, name: "Navigation" })).toBeVisible();
    await expect(dialog.getByText("Go to Now")).toBeVisible();
    await evidence(page, testInfo, "shortcut-help");
    await expectNoAxeViolations(page);

    const search = dialog.getByRole("searchbox", { name: "Search shortcuts by action or keys" });
    await search.fill("g c");
    await expect(dialog.getByText("Open Simon chat")).toBeVisible();
    await expect(dialog.getByText("Go to Now")).toHaveCount(0);
    await evidence(page, testInfo, "shortcut-help-search");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(vault).toBeFocused();
  });

  test("opens from the profile menu for pointer and touch", async ({ page }, testInfo) => {
    await stubApi(page);
    await openApp(page, "/now");
    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("menuitem", { name: /Shortcut help/ }).click();
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await evidence(page, testInfo, "shortcut-help-menu");
    await dialog.getByRole("button", { name: "Close keyboard shortcuts" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
