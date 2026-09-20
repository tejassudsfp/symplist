import { expect, test } from "@playwright/test";
import { ownerApi } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

test("consent is explicit: decline sends no events, then an allowlisted appearance event excludes private values", async ({
  context,
  page,
}) => {
  await signIn(context, { analyticsConsent: "unset" });
  const eventBodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/analytics/events")) eventBodies.push(request.postData() ?? "");
  });
  await page.goto("/now");
  const banner = page.getByLabel("Product analytics choice");
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Decline" }).click();
  await expect(banner).toBeHidden();
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: /Meadow/ }).check({ force: true });
  await expect(page.getByText("Saved to your account")).toBeVisible();
  await expect.poll(() => eventBodies).toEqual([]);

  const api = await ownerApi(context);
  const denied = await api.post("/analytics/events", {
    event: "appearance_changed",
    eventId: crypto.randomUUID(),
    properties: { changed: "theme", theme: "meadow", accent: "preset", mode: "light" },
  });
  expect(denied.status()).toBe(403);

  await page.goto("/settings/account");
  const toggle = page.getByLabel("Share product usage");
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: "Dark", exact: true }).check({ force: true });
  await expect.poll(() => eventBodies.length).toBeGreaterThan(0);
  const payload = eventBodies.at(-1) ?? "";
  expect(payload).toContain("appearance_changed");
  expect(payload).not.toContain("analytics_id");
  expect(payload).not.toContain("http");
  expect(payload).not.toContain("private");
});
