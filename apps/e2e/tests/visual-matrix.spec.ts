/// <reference lib="dom" />
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { documentPublishResponseSchema, taskCreateResponseSchema } from "@symplist/contracts";
import { captureEvidence, expectNoAxeViolations } from "../src/helpers/index.ts";
import { readRunEnv } from "../src/helpers/local-api.ts";
import { signIn } from "../src/helpers/session.ts";

const evidenceDirectory = fileURLToPath(new URL("../evidence/visual-matrix/", import.meta.url));
const themes = ["studio", "paper", "pebble", "postcard", "meadow", "tide"] as const;
const parentTitle = "Refresh my portfolio";
const children = ["Choose three recent projects", "Write a short introduction"] as const;
const otherTitles = ["Send the project outline", "Book a bike tune-up"] as const;

/** Computed browser colors are sRGB; these controls use opaque foregrounds and surfaces. */
function contrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.map(Number);
    if (channels?.length !== 3) throw new Error(`Expected opaque sRGB: ${color}`);
    return channels.reduce((sum, value, index) => {
      const channel = value / 255;
      const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
    }, 0);
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Every frame uses a fresh real account, API-created tasks and a published encrypted Git page.
// No route interception, DOM theme overrides or synthetic screen contents are used.
for (const theme of themes) {
  for (const mode of ["light", "dark"] as const) {
    test(`populated workspace · ${theme} · ${mode}`, async ({ page, context }, testInfo) => {
      await signIn(context);
      const env = readRunEnv();
      const origin = env.API_ORIGIN ?? "";
      const csrfResponse = await context.request.get(`${origin}/v1/auth/csrf`, {
        headers: { Origin: env.WEB_ORIGIN ?? "" },
      });
      expect(csrfResponse.ok()).toBe(true);
      const { token } = (await csrfResponse.json()) as { token: string };
      const headers = { Origin: env.WEB_ORIGIN ?? "", "X-Symplist-CSRF": token };
      const write = (path: string, data: unknown) =>
        context.request.post(`${origin}${path}`, {
          headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
          data,
        });
      const name = await context.request.put(`${origin}/v1/me/name`, {
        headers,
        data: { displayName: "Maya Rao" },
      });
      expect(name.ok()).toBe(true);
      const appearance = await context.request.put(`${origin}/v1/preferences/appearance`, {
        headers,
        data: { baseVersion: 0, clientSeq: 1, data: { themeId: theme, mode, accent: "violet" } },
      });
      expect(appearance.ok()).toBe(true);
      const createTask = async (title: string, parentId?: string) => {
        const response = await write("/v1/tasks", {
          title,
          ...(parentId === undefined ? { collection: "now" } : { parentId }),
        });
        expect(response.status()).toBe(201);
        return taskCreateResponseSchema.parse(await response.json()).task;
      };
      const parent = await createTask(parentTitle);
      for (const title of children) await createTask(title, parent.id);
      for (const title of otherTitles) await createTask(title);
      const publication = await write(`/v1/tasks/${parent.id}/document/commits`, {
        baseRevision: null,
        markdown:
          "# A small, thoughtful refresh\n\nMake room for the work I am proud of. Keep the page simple, useful, and easy to read.\n\n## Projects to include\n\n- A quieter reading app\n- The neighbourhood garden journal\n- A welcoming studio website\n\n## Next steps\n\nChoose three recent projects, write a short introduction, and ask a friend to read it.\n\n> Good work deserves a little breathing room.\n",
      });
      expect(publication.status()).toBe(201);
      documentPublishResponseSchema.parse(await publication.json());

      // Desktop shows the saved page alongside its list. Narrow screens show the actual list as
      // their primary surface, not a hidden list behind an opened page/drawer.
      await page.goto(testInfo.project.name === "desktop" ? `/now/${parent.id}` : "/now");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      const tree = page.getByRole("tree", { name: "Now tasks" });
      await expect(tree).toBeVisible();
      const expand = page.getByRole("button", { name: `Expand ${parentTitle} subtasks` });
      if (await expand.count()) await expand.click();
      for (const title of [parentTitle, ...children, ...otherTitles]) {
        await expect(tree.getByText(title, { exact: true })).toBeVisible();
      }
      await expect(tree.locator(".sym-task-row")).toHaveCount(5);
      if (testInfo.project.name === "desktop") {
        await expect(
          page.getByRole("heading", { name: "A small, thoughtful refresh" }),
        ).toBeVisible();
      }
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      // Keep a real keyboard focus marker visible and prove the list has an entry point.
      const firstRow = tree.locator(".sym-task-row").filter({
        has: page.getByText(parentTitle, { exact: true }),
      });
      await expect(firstRow).toHaveAttribute("tabindex", "0");
      await firstRow.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        tree.locator(".sym-task-row").filter({
          has: page.getByText(children[0], { exact: true }),
        }),
      ).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(firstRow).toBeFocused();
      await expect(firstRow).toHaveCSS("outline-style", "solid");
      // Axe does not test non-text UI boundary contrast. The unchecked control must remain
      // distinguishable from its own fill, and the bell must use the actual chrome surface.
      const controls = await page.evaluate(() => {
        const check = document.querySelector(".sym-task-check");
        const bell = document.querySelector(".sym-notification-control");
        const chrome = document.querySelector(".sym-topbar");
        if (!check || !bell || !chrome) throw new Error("Missing workspace controls");
        return {
          checkBorder: getComputedStyle(check).borderTopColor,
          checkFill: getComputedStyle(check).backgroundColor,
          bellInk: getComputedStyle(bell).color,
          chromeFill: getComputedStyle(chrome).backgroundColor,
        };
      });
      expect(
        contrast(controls.checkBorder, controls.checkFill),
        "unchecked checkbox boundary",
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(controls.bellInk, controls.chromeFill),
        "notification bell on chrome",
      ).toBeGreaterThanOrEqual(3);
      await expectNoAxeViolations(page, testInfo, { label: `${theme}-${mode}` });
      await captureEvidence(
        page,
        testInfo,
        {
          screen: "workspace_now",
          state: "populated",
          theme,
          mode,
        },
        { keepIn: evidenceDirectory, fullPage: false },
      );
    });
  }
}
