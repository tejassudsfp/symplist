import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { captureEvidence, expectNoAxeViolations } from "../src/helpers/index.ts";
import { signIn } from "../src/helpers/session.ts";

const evidenceDir = fileURLToPath(new URL("../evidence/about", import.meta.url));

test("About presents the open-source identity and an accessible license dialog", async ({
  context,
  page,
}, testInfo) => {
  await signIn(context);
  await page.goto("/settings/about");

  await expect(page.getByRole("heading", { level: 1, name: "About Symplist" })).toBeVisible();
  await expect(page.getByText("symplist", { exact: true })).toBeVisible();
  await expect(
    page.getByText("“The most productive thing is often the most simple.”", { exact: true }),
  ).toBeVisible();

  const author = page.getByRole("link", { name: /Tejas Parthasarathi Sudarshan/ });
  await expect(author).toHaveAttribute("href", "https://tejassuds.com");
  const repository = page.getByRole("link", { name: /Source repository/ });
  await expect(repository).toHaveAttribute("href", "https://github.com/tejassudsfp/symplist");
  await expect(repository).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: /Self-hosting/ })).toHaveAttribute(
    "href",
    "https://github.com/tejassudsfp/symplist/blob/main/SELF_HOSTING.md",
  );
  await expect(page.getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "← Back to workspace" })).toHaveAttribute(
    "href",
    "/now",
  );

  await expectNoAxeViolations(page, testInfo, { label: "about-overview-axe" });
  await captureEvidence(
    page,
    testInfo,
    { screen: "about", state: "overview" },
    { keepIn: evidenceDir },
  );

  const trigger = page.getByRole("button", { name: "View license" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "MIT License" });
  await expect(dialog).toBeVisible();
  // Axe must inspect the settled dialog, not a partially transparent frame of its 150 ms entrance.
  await expect(dialog).toHaveCSS("opacity", "1");
  const license = dialog.getByRole("textbox", { name: "MIT License text" });
  await expect(license).toBeFocused();
  await expect(license).toHaveValue(/Copyright \(c\) 2026 Tejas Parthasarathi Sudarshan/);
  await expect(license).toHaveValue(/THE SOFTWARE IS PROVIDED "AS IS"/);

  await expectNoAxeViolations(page, testInfo, { label: "about-license-axe" });
  await captureEvidence(
    page,
    testInfo,
    { screen: "about", state: "license-open" },
    { fullPage: false, keepIn: evidenceDir },
  );

  await dialog.getByRole("button", { name: "Close license" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
