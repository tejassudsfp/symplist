import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { captureEvidence, expectNoAxeViolations } from "../src/helpers/index.ts";

const EVIDENCE_DIR = fileURLToPath(new URL("../evidence/marketing/", import.meta.url));

/** The public pages, signed out: a stranger must be able to read all of this without an account. */
test.describe("the public site", () => {
  test("shows the homepage and every legal page to a signed-out visitor", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("most productive thing");
    await captureEvidence(
      page,
      testInfo,
      { screen: "home", state: "signed-out" },
      {
        keepIn: EVIDENCE_DIR,
        fullPage: true,
      },
    );
    await expectNoAxeViolations(page, testInfo, { label: "home" });

    for (const [name, heading] of [
      ["Privacy", "Privacy"],
      ["Terms", "Terms of use"],
      ["Cookies", "Cookies"],
    ] as const) {
      await page.getByRole("contentinfo").getByRole("link", { name }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await expectNoAxeViolations(page, testInfo, { label: `legal-${name.toLowerCase()}` });
      await page.goto("/");
    }
  });

  test("serves robots, the sitemap and llms.txt", async ({ page }) => {
    const robots = await page.request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain("Sitemap: https://symplist.app/sitemap.xml");

    const sitemap = await page.request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    for (const path of ["", "/privacy", "/terms", "/cookies"]) {
      expect(xml).toContain(`https://symplist.app${path}<`);
    }

    // An assistant reads this before it answers anything about the product, so the claims in it have
    // to be the accurate ones rather than the flattering ones.
    const llms = await page.request.get("/llms.txt");
    expect(llms.status()).toBe(200);
    const text = await llms.text();
    expect(text).toContain("https://api.symplist.app/mcp");
    expect(text).toContain("not end-to-end encryption");
    expect(text).toContain("Symplist is free");
  });

  test("offers to let a visitor's own assistant answer for us", async ({ page }) => {
    await page.goto("/");
    const ask = page.getByRole("link", { name: /^Ask ChatGPT/ });
    await expect(ask).toHaveAttribute("href", /chatgpt\.com\/.*llms\.txt/);
    // All six, each with a real brand mark rather than a shape drawn from memory.
    for (const name of ["Claude", "Gemini", "Perplexity", "Grok", "Copilot"]) {
      await expect(page.getByRole("link", { name: new RegExp(`^Ask ${name}`) })).toBeVisible();
    }
    await expect(page.locator(".sym-ask-row a")).toHaveCount(6);

    // The marks have to actually load. They were silently 302'd to /signin once, because the proxy
    // matcher excluded `brand/` and `licenses/` but not `ai/`, and a broken <img> renders as nothing.
    for (const file of ["openai.svg", "claude-color.svg", "gemini-color.svg", "grok.svg"]) {
      const response = await page.request.get(`/ai/${file}`);
      expect(response.status(), file).toBe(200);
      expect(response.headers()["content-type"]).toContain("svg");
    }
  });

  test("the way into the workspace is present and goes to the list", async ({ page }) => {
    await page.goto("/");
    const open = page.getByRole("link", { name: "Open Symplist" }).first();
    await expect(open).toHaveAttribute("href", "/now");
  });
});
