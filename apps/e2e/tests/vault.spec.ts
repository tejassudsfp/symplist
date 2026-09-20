/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { captureEvidence } from "../src/helpers/evidence.ts";
import { expectNoAxeViolations } from "../src/helpers/index.ts";
import { signIn } from "../src/helpers/session.ts";

const apiOrigin =
  process.env.NEXT_PUBLIC_API_URL ?? `http://127.0.0.1:${process.env.E2E_API_PORT ?? 4000}`;
const webOrigin = process.env.E2E_WEB_URL ?? `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 3000}`;
const originalKey = "a fictional vault phrase for browser tests";
const newKey = "a different fictional vault phrase after recovery";

test("Vault setup, edit, lock, fresh-OTP recovery and preserved contents", async ({
  page,
  context,
}, testInfo) => {
  const identity = await signIn(context);
  await page.goto("/vault");
  await expect(
    page.getByRole("heading", { name: "Keep sensitive notes and keys here." }),
  ).toBeVisible();
  await captureEvidence(page, testInfo, { screen: "vault_setup", state: "default" });
  await expectNoAxeViolations(page, testInfo);
  await page.getByLabel("Create a vault key", { exact: true }).fill(originalKey);
  await page.getByLabel("Confirm vault key", { exact: true }).fill(originalKey);
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Private integration key");
  await page.getByLabel("Secret value", { exact: true }).fill("fictional-private-browser-marker");
  await captureEvidence(page, testInfo, { screen: "vault_item_editor", state: "secret-draft" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Private integration key" })).toBeVisible();
  await expect(page.getByText("fictional-private-browser-marker", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reveal secret", exact: true }).click();
  await expect(page.getByText("fictional-private-browser-marker", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide secret", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Private integration key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Private integration key" })).toBeVisible();
  await captureEvidence(page, testInfo, { screen: "vault_items", state: "populated" });
  await expectNoAxeViolations(page, testInfo);
  const back = page.getByRole("button", { name: "Back to items", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByRole("radio", { name: "Secure note", exact: true }).check();
  await page.getByLabel("Title", { exact: true }).fill("Recovery notes");
  await page
    .getByRole("textbox", { name: "Secure note", exact: true })
    .fill("## Recovery\nFictional recovery guidance.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recovery", exact: true })).toBeVisible();
  if (await back.isVisible()) await back.click();
  for (const theme of ["studio", "paper", "pebble", "postcard", "meadow", "tide"]) {
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(
        ({ theme, mode }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.mode = mode;
        },
        { theme, mode },
      );
      await captureEvidence(page, testInfo, {
        screen: "vault_items",
        state: "populated-list",
        theme,
        mode,
      });
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "studio";
    document.documentElement.dataset.mode = "light";
  });
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await expect(page.getByText("Private integration key", { exact: true })).toHaveCount(0);
  await captureEvidence(page, testInfo, { screen: "vault_unlock", state: "locked" });
  await page.getByLabel("Vault key", { exact: true }).fill(originalKey);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("button", { name: /Private integration key/ })).toBeVisible();
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await page.getByRole("button", { name: "Forgot key?", exact: true }).click();
  await page.getByRole("button", { name: "Send reset code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verify vault reset" })).toBeVisible();
  const delivered = await context.request.post(`${apiOrigin}/v1/auth/test/otp`, {
    headers: { Origin: webOrigin, "X-Symplist-CSRF": "1" },
    data: { email: identity.email, purpose: "vault_reset" },
  });
  expect(delivered.status(), await delivered.text()).toBe(200);
  const body: { code: string } = await delivered.json();
  await page.getByLabel("Verification code", { exact: true }).fill(body.code);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a new vault key" })).toBeVisible();
  await captureEvidence(page, testInfo, { screen: "vault_reset", state: "verified" });
  await page.getByLabel("New vault key", { exact: true }).fill(newKey);
  await page.getByLabel("Confirm vault key", { exact: true }).fill(newKey);
  await page.getByRole("button", { name: "Reset vault key", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.getByLabel("Vault key", { exact: true }).fill(newKey);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("button", { name: /Private integration key/ }).click();
  await page.getByRole("button", { name: "Reveal secret", exact: true }).click();
  await expect(page.getByText("fictional-private-browser-marker", { exact: true })).toBeVisible();
});
