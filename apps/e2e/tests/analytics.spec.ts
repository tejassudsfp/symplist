import { expect, test } from "@playwright/test";
import { analyticsSettingsSchema } from "@symplist/contracts";
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
  const declineSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && response.url().endsWith("/analytics/consent"),
  );
  await banner.getByRole("button", { name: "Decline" }).click();
  expect((await declineSaved).status()).toBe(200);
  await expect(banner).toBeHidden();
  await page.goto("/settings/appearance");
  const deniedCapture = page
    .waitForRequest((request) => request.url().endsWith("/v1/analytics/events"), { timeout: 750 })
    .then(
      () => true,
      () => false,
    );
  await page.getByRole("radio", { name: /Meadow/ }).check({ force: true });
  await expect(page.getByText("Saved to your account")).toBeVisible();
  expect(await deniedCapture).toBe(false);
  expect(eventBodies).toEqual([]);

  const api = await ownerApi(context);
  const storedConsent = await api.get("/analytics/consent");
  expect(storedConsent.status()).toBe(200);
  expect(analyticsSettingsSchema.parse(await storedConsent.json()).consent.state).toBe("denied");
  const denied = await api.post("/analytics/events", {
    event: "appearance_changed",
    eventId: crypto.randomUUID(),
    properties: { changed: "theme", theme: "meadow", accent: "preset", mode: "light" },
  });
  // The non-blocking relay always acknowledges a valid event shape; its fresh stored-consent read
  // suppresses delivery. The API contract suite spies on the emitter and proves this exact path.
  expect(denied.status()).toBe(204);

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
