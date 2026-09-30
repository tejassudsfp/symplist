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

  test("the way into the workspace is present and goes to the list", async ({ page }) => {
    await page.goto("/");
    const open = page.getByRole("link", { name: "Open Symplist" }).first();
    await expect(open).toHaveAttribute("href", "/now");
  });
});
