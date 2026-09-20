import { expect, test } from "@playwright/test";
import { readRunEnv } from "../src/helpers/local-api.ts";
import { setAccessState } from "../src/helpers/phase-e.ts";
import { signIn } from "../src/helpers/session.ts";

interface LoginCode {
  readonly challengeId: string;
  readonly code: string;
}

test("a returning OTP login routes every current access state before protected UI renders", async ({
  context,
  page,
}, testInfo) => {
  test.slow();
  const env = readRunEnv();
  const projectAddresses: Readonly<Record<string, string>> = {
    desktop: "192.0.2.31",
    laptop: "192.0.2.32",
    mobile: "192.0.2.33",
  };
  const clientAddress = projectAddresses[testInfo.project.name];
  if (!clientAddress) throw new Error(`No test client address for ${testInfo.project.name}`);
  // This route stands in for the single trusted proxy hop. Injecting at the network boundary keeps
  // browser CORS production-shaped while giving each viewport its own real IP-limit bucket.
  await page.route(`${env.API_ORIGIN}/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-forwarded-for": clientAddress },
    }),
  );
  const cases = [
    {
      state: "unlocked",
      path: /\/now$/,
      heading: null,
      detail: null,
    },
    {
      state: "locked",
      path: /\/access$/,
      heading: "You're signed in",
      detail: "Invite code",
    },
    {
      state: "relocked",
      path: /\/access\/paused$/,
      heading: "Access is currently paused",
      detail: "An administrator paused this account's beta access",
    },
    {
      state: "suspended",
      path: /\/access\/paused$/,
      heading: "Access is currently paused",
      detail: "This account is suspended",
    },
  ] as const;

  for (const expected of cases) {
    await test.step(expected.state, async () => {
      const account = await signIn(context);
      await setAccessState(account.userId, expected.state);
      await context.clearCookies();

      await page.goto("/signin");
      await page.getByLabel("Email", { exact: true }).fill(account.email);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page).toHaveURL(/\/signin\/verify$/);
      await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

      const delivered = await context.request.post(`${env.API_ORIGIN}/v1/auth/test/otp`, {
        headers: { Origin: env.WEB_ORIGIN ?? "", "X-Symplist-CSRF": "1" },
        data: { email: account.email, purpose: "login" },
      });
      expect(delivered.status(), await delivered.text()).toBe(200);
      const challenge = (await delivered.json()) as LoginCode;
      expect(challenge.code).toMatch(/^\d{6}$/);
      await page.getByLabel(/digit code/).fill(challenge.code);

      await expect(page).toHaveURL(expected.path);
      if (expected.heading) {
        await expect(page.getByRole("heading", { name: expected.heading })).toBeVisible();
      } else {
        await expect(page.getByRole("banner")).toBeVisible();
      }
      if (expected.detail === "Invite code") {
        await expect(page.getByLabel("Invite code", { exact: true })).toBeVisible();
      } else if (expected.detail) {
        await expect(page.getByText(expected.detail, { exact: false })).toBeVisible();
        await expect(page.getByLabel("Invite code", { exact: true })).toHaveCount(0);
      }
    });
  }
});
