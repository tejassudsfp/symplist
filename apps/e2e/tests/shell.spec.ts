/// <reference lib="dom" />
// Callbacks passed to page.evaluate run in the browser, so this spec needs the DOM types.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
const taskPath = `/now/${taskId}`;
const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const evidenceDir = fileURLToPath(new URL("../evidence/shell/", import.meta.url));
const themeIds = ["studio", "paper", "pebble", "postcard", "meadow", "tide"] as const;

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

async function expectNoAxeViolations(page: Page) {
  // Let entrance animations settle so contrast is measured on final colors.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
        )
        .map((animation) => animation.finished),
    ),
  );
  const results = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
  expect(summary).toEqual([]);
}

/** The accessible name (or text) and role of the focused element, for focus-order assertions. */
async function focusedDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "(body)";
    const name =
      element.getAttribute("aria-label") ?? element.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
    return `${role}:${name}`;
  });
}

async function tabSequence(page: Page, count: number): Promise<string[]> {
  const sequence: string[] = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
    sequence.push(await focusedDescriptor(page));
  }
  return sequence;
}

async function trackCspViolations(page: Page) {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = store;
    document.addEventListener("securitypolicyviolation", (event) => {
      store.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

async function openShell(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-theme", /.+/);
  // Wait for hydration: the keyboard dispatcher and panel library attach on the client.
  await page.waitForFunction(() => document.querySelector("[data-group]") !== null);
  await page.waitForLoadState("networkidle");
}

test.describe("app shell", () => {
  test("renders the workspace landmarks on /now", async ({ page }, testInfo) => {
    await openShell(page, "/now");
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Vault" })).toBeVisible();
    // On phones the list is the single visible surface; the page region waits for a task.
    if (project(testInfo) === "mobile") await expect(page.locator("main")).toBeHidden();
    else await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator("h1", { hasText: "Now" })).toBeAttached();
    await expect(page.getByRole("navigation", { name: "Collections" })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Collections" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Now" })).toBeVisible();
    await expect(page.getByRole("complementary")).toHaveCount(0);
    if (project(testInfo) === "mobile") {
      await expect(page.getByRole("link", { name: "Later" })).toBeVisible();
    } else {
      await expect(page.getByText("Pick a task to open its page")).toBeVisible();
    }
    await evidence(page, testInfo, "now");
  });

  test("renders a task page with its chat frame", async ({ page }, testInfo) => {
    await openShell(page, taskPath);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Task page" })).toBeAttached();
    if (project(testInfo) === "mobile") {
      await expect(page.getByRole("complementary")).toBeHidden();
      await expect(page.getByRole("link", { name: "Back to Now" })).toBeVisible();
    } else {
      await expect(page.getByRole("complementary", { name: "Simon" })).toBeVisible();
    }
    await evidence(page, testInfo, "task");
  });

  test("keeps a logical keyboard focus order", async ({ page }, testInfo) => {
    await openShell(page, "/now");
    const expectedNow: Record<ProjectName, string[]> = {
      desktop: [
        "a:Skip to content",
        "button:Account menu",
        "a:Vault",
        "a:Now",
        "a:Later",
        "a:Unclassified",
        "button:Hide task list",
        "separator:Resize task list",
      ],
      laptop: [
        "a:Skip to content",
        "button:Account menu",
        "a:Vault",
        "a:Now",
        "a:Later",
        "a:Unclassified",
        "button:Hide task list",
      ],
      mobile: [
        "a:Skip to content",
        "button:Account menu",
        "a:Vault",
        "a:Now",
        "a:Later",
        "a:Unclassified",
      ],
    };
    const nowOrder = expectedNow[project(testInfo)];
    expect(await tabSequence(page, nowOrder.length)).toEqual(nowOrder);

    await openShell(page, taskPath);
    const expectedTask: Record<ProjectName, string[]> = {
      desktop: [
        "a:Skip to content",
        "button:Account menu",
        "a:Vault",
        "a:Now",
        "a:Later",
        "a:Unclassified",
        "button:Hide task list",
        "separator:Resize task list",
        "separator:Resize chat",
        "button:Hide chat",
      ],
      laptop: [
        "a:Skip to content",
        "button:Account menu",
        "a:Vault",
        "a:Now",
        "a:Later",
        "a:Unclassified",
        "button:Show task list",
        "button:Hide chat",
      ],
      mobile: [
        "a:Skip to content",
        "button:Account menu",
        "a:Vault",
        "a:Back to Now",
        "button:Chat",
      ],
    };
    const taskOrder = expectedTask[project(testInfo)];
    expect(await tabSequence(page, taskOrder.length)).toEqual(taskOrder);
  });

  test("the skip link moves focus to the primary content", async ({ page }, testInfo) => {
    await openShell(page, "/now");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    if (project(testInfo) === "mobile") {
      await expect(page.getByRole("heading", { level: 2, name: "Now" })).toBeFocused();
    } else {
      await expect(page.getByRole("main")).toBeFocused();
    }
    await openShell(page, taskPath);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("passes axe WCAG 2.2 AA checks", async ({ page }, testInfo) => {
    await openShell(page, "/now");
    await expectNoAxeViolations(page);
    await openShell(page, taskPath);
    await expectNoAxeViolations(page);
    if (project(testInfo) !== "mobile") {
      await page.getByRole("button", { name: "Account menu" }).click();
      await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
      await expectNoAxeViolations(page);
      await evidence(page, testInfo, "profile-menu");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Account menu" })).toBeFocused();
    }
  });

  test("sends the security headers and raises no CSP violations", async ({ page }) => {
    await trackCspViolations(page);
    const response = await page.goto(taskPath);
    const headers = response?.headers() ?? {};
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    await page.waitForFunction(() => document.querySelector("[data-group]") !== null);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.keyboard.press("Escape");
    expect(await cspViolations(page)).toEqual([]);
  });

  test("renders the saved appearance on first paint for every theme and mode", async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    test.skip(
      project(testInfo) !== "desktop",
      "Theme contrast is checked once, at the desktop viewport.",
    );
    for (const themeId of themeIds) {
      for (const mode of ["light", "dark"] as const) {
        await context.addCookies([
          { name: "sym_appearance", value: `v1.${themeId}.${mode}.violet`, url: baseURL ?? "" },
        ]);
        const response = await page.goto(taskPath);
        const html = (await response?.text()) ?? "";
        expect(html).toContain(`data-theme="${themeId}"`);
        expect(html).toContain(`data-mode="${mode}"`);
        await page.waitForFunction(() => document.querySelector("[data-group]") !== null);
        await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
        // The sample's panel widths (task list 280 px, chat 340 px) hold inside every theme's
        // inset frame.
        const inboxBox = await page.getByRole("region", { name: "Now" }).boundingBox();
        const chatBox = await page.getByRole("complementary", { name: "Simon" }).boundingBox();
        expect(Math.round(inboxBox?.width ?? 0), `${themeId} task list width`).toBe(280);
        expect(Math.round(chatBox?.width ?? 0), `${themeId} chat width`).toBe(340);
        await expectNoAxeViolations(page);
        await evidence(page, testInfo, `theme-${themeId}-${mode}`);
      }
    }
  });

  test("follows the device brightness in System mode without a reload", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "sym_appearance", value: "v1.paper.system.teal", url: baseURL ?? "" },
    ]);
    await page.emulateMedia({ colorScheme: "dark" });
    await openShell(page, "/now");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-mode", "system");
    await expect(html).toHaveCSS("color-scheme", "dark");
    // Paper Dark `bg` #1F1B17 and Paper Light `bg` #EFEAE0 from the sample.
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(31, 27, 23)");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).toHaveCSS("color-scheme", "light");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(239, 234, 224)");
  });

  test("falls back to the default theme without losing accent and mode", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "sym_appearance", value: "v1.retired.dark.teal", url: baseURL ?? "" },
    ]);
    await openShell(page, "/now");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "studio");
    await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  });

  test("desktop panels collapse to the rail and corner controls and come back", async ({
    page,
  }, testInfo) => {
    test.skip(
      project(testInfo) !== "desktop",
      "Resizable, collapsible panels are the desktop layout.",
    );
    await openShell(page, taskPath);
    const inbox = page.getByRole("region", { name: "Now" });
    const chat = page.getByRole("complementary", { name: "Simon" });
    const separator = page.getByRole("separator", { name: "Resize task list" });
    const before = await separator.getAttribute("aria-valuenow");
    await separator.focus();
    await page.keyboard.press("ArrowRight");
    await expect(separator).not.toHaveAttribute("aria-valuenow", before ?? "");

    await page.getByRole("button", { name: "Hide task list" }).click();
    await expect(inbox).toBeHidden();
    const showList = page.getByRole("button", { name: "Show task list" });
    await expect(showList).toBeVisible();
    await page.getByRole("button", { name: "Hide chat" }).click();
    await expect(chat).toBeHidden();
    const corner = page.getByRole("button", { name: "Show chat" });
    await expect(corner).toBeFocused();
    await evidence(page, testInfo, "panels-collapsed");

    await corner.click();
    await expect(chat).toBeVisible();
    await showList.click();
    await expect(inbox).toBeVisible();
    const box = await inbox.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(240);
    expect(box?.width ?? 0).toBeLessThanOrEqual(400);
  });

  test("laptop width floats the task list as a drawer", async ({ page }, testInfo) => {
    test.skip(project(testInfo) !== "laptop", "The drawer is the 1024 px layout.");
    await openShell(page, "/now");
    const inbox = page.getByRole("region", { name: "Now" });
    await expect(inbox).toBeVisible();
    await page.getByRole("main").click({ position: { x: 600, y: 300 } });
    await expect(inbox).toBeHidden();
    const nowIcon = page
      .getByRole("navigation", { name: "Collections" })
      .getByRole("link", { name: "Now" });
    await nowIcon.click();
    await expect(inbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inbox).toBeHidden();

    await openShell(page, taskPath);
    await expect(inbox).toBeHidden();
    await expect(page.getByRole("complementary", { name: "Simon" })).toBeVisible();
    await page.getByRole("button", { name: "Show task list" }).click();
    await expect(inbox).toBeVisible();
    await evidence(page, testInfo, "drawer-open");
  });

  test("phones show one surface at a time", async ({ page }, testInfo) => {
    test.skip(project(testInfo) !== "mobile", "Single-surface navigation is the 390 px layout.");
    await openShell(page, "/now");
    await page.getByRole("link", { name: "Later" }).click();
    await expect(page).toHaveURL(/\/later$/);
    await expect(page.getByRole("region", { name: "Later" })).toBeVisible();

    await openShell(page, taskPath);
    await expect(page.getByRole("region", { name: "Now" })).toBeHidden();
    await page.getByRole("button", { name: "Chat" }).click();
    const chat = page.getByRole("complementary", { name: "Simon" });
    await expect(chat).toBeVisible();
    await expect(page.getByRole("main")).toBeHidden();
    await evidence(page, testInfo, "chat");
    await chat.getByRole("button", { name: "Page", exact: true }).click();
    await expect(page.getByRole("main")).toBeVisible();
    await page.getByRole("link", { name: "Back to Now" }).click();
    await expect(page).toHaveURL(/\/now$/);
    await expect(page.getByRole("region", { name: "Now" })).toBeVisible();
  });

  test("keyboard sequences navigate and never fire while typing", async ({ page }, testInfo) => {
    test.skip(
      project(testInfo) === "mobile",
      "Hardware keyboard shortcuts are covered at desktop and laptop widths.",
    );
    await openShell(page, "/now");
    await page.locator("body").click({ position: { x: 700, y: 500 } });
    await page.keyboard.press("g");
    await expect(page.locator("[data-slot=sequence-hint]")).toBeVisible();
    await page.keyboard.press("l");
    await expect(page).toHaveURL(/\/later$/);
    // Collection shortcuts open the collection with its task list focused (note 13).
    await expect(page.getByRole("heading", { level: 2, name: "Later" })).toBeFocused();

    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "probe";
      input.setAttribute("aria-label", "Probe");
      document.querySelector("main")?.append(input);
    });
    await page.getByRole("textbox", { name: "Probe" }).focus();
    await page.keyboard.type("gn");
    await expect(page).toHaveURL(/\/later$/);
    await expect(page.getByRole("textbox", { name: "Probe" })).toHaveValue("gn");
  });
});
