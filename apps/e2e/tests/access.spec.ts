/// <reference lib="dom" />
// Callbacks passed to page.evaluate run in the browser, so this spec needs the DOM types.

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { expectNoAxeViolations } from "../src/helpers/index.ts";
import { E2E_ADMIN_EMAIL } from "../src/helpers/local-api.ts";

/*
 * The access flows end to end (§5, notes 03 and 04): explicit signup consent, an emailed code, the
 * locked beta gate, an administrator generating an invite, redemption, onboarding and the workspace,
 * then a relock that blocks access and a restore that returns it. The api runs with local drivers and
 * `NODE_ENV=test`, so the suite reads the delivered code from the test-only outbox (decision AC12)
 * instead of a mailbox; codes still never appear in a response to anyone else.
 */

const evidenceDir = fileURLToPath(new URL("../evidence/access/", import.meta.url));

const webOrigin = process.env.E2E_WEB_URL ?? `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 3000}`;
const apiOrigin =
  process.env.NEXT_PUBLIC_API_URL ?? `http://127.0.0.1:${process.env.E2E_API_PORT ?? 4000}`;
const adminEmail = E2E_ADMIN_EMAIL;

/** One admin session per Playwright run, shared by every project's worker. */
const runRoot = join(tmpdir(), `symplist-e2e-access-${process.ppid}`);
const adminStatePath = join(runRoot, "admin-state.json");

mkdirSync(evidenceDir, { recursive: true });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${apiOrigin}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Waits for the api Playwright starts (`playwright.config.ts`, second `webServer` entry). This spec
 * used to spawn an api of its own with an environment written out beside it; once the workspace
 * feature gave the whole suite one, two environments had to agree about `NODE_ENV`, the data
 * directory and `ADMIN_BOOTSTRAP_EMAIL` — and they stopped agreeing, which is why every access
 * journey failed at the first emailed code. `helpers/local-api.ts` now owns that environment alone.
 */
async function ensureApi(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await sleep(250);
  }
  throw new Error(
    `No api answered at ${apiOrigin}/healthz. Run this suite with \`pnpm e2e\`, which builds the repository and starts the api, rather than against E2E_WEB_URL.`,
  );
}

/** The pre-session headers the api's `pre_session` route class requires (§5.3). */
const preSessionHeaders = { Origin: webOrigin, "X-Symplist-CSRF": "1" };

interface Challenge {
  readonly challengeId: string;
  readonly code: string;
}

/** Reads the code this api process delivered to an address, as the e2e suite is allowed to (AC12). */
async function deliveredCode(
  request: APIRequestContext,
  email: string,
  purpose: "login" | "signup" | "account_delete",
): Promise<Challenge> {
  const response = await request.post(`${apiOrigin}/v1/auth/test/otp`, {
    headers: preSessionHeaders,
    data: { email, purpose },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as Challenge;
  expect(body.code).toMatch(/^\d{6}$/);
  return body;
}

/**
 * Signs the operator in once per run and saves the session, because one address may only be sent a
 * few codes an hour (§5.1) and every project needs an administrator.
 */
async function ensureAdminSession(request: APIRequestContext): Promise<string> {
  if (existsSync(adminStatePath)) return adminStatePath;
  mkdirSync(runRoot, { recursive: true });
  let owner = false;
  try {
    mkdirSync(join(runRoot, "admin.lock"));
    owner = true;
  } catch {
    owner = false;
  }
  if (!owner) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (existsSync(adminStatePath)) return adminStatePath;
      await sleep(250);
    }
    throw new Error("The administrator session was never written");
  }
  const signup = await request.post(`${apiOrigin}/v1/auth/signup`, {
    headers: preSessionHeaders,
    data: { email: adminEmail, consent: true },
  });
  expect(signup.status(), await signup.text()).toBe(201);
  const challenge = await deliveredCode(request, adminEmail, "signup");
  const verify = await request.post(`${apiOrigin}/v1/auth/otp/verify`, {
    headers: preSessionHeaders,
    data: { challengeId: challenge.challengeId, code: challenge.code },
  });
  expect(verify.status(), await verify.text()).toBe(200);
  const me = (await verify.json()) as { user: { role: string } };
  // Bootstrap promotes exactly this address on its first verification (§5.7).
  expect(me.user.role).toBe("admin");

  // Bootstrap admits the account but does not finish its onboarding, and every administration route
  // sits behind the `admin` level, which needs a destination of "app" (§5.4) — so an operator who
  // never answered "What should we call you?" is sent back to onboarding instead. The operator
  // answers it here, through the same two calls the onboarding screens make.
  const csrf = await request.get(`${apiOrigin}/v1/auth/csrf`, { headers: { Origin: webOrigin } });
  expect(csrf.status(), await csrf.text()).toBe(200);
  const sessionHeaders = {
    Origin: webOrigin,
    "X-Symplist-CSRF": ((await csrf.json()) as { token: string }).token,
  };
  const named = await request.put(`${apiOrigin}/v1/me/name`, {
    headers: sessionHeaders,
    data: { displayName: "Operator" },
  });
  expect(named.status(), await named.text()).toBe(200);
  const onboarded = await request.post(`${apiOrigin}/v1/me/onboarding/complete`, {
    headers: sessionHeaders,
    data: {},
  });
  expect(onboarded.status(), await onboarded.text()).toBe(200);
  expect(((await onboarded.json()) as { destination: string }).destination).toBe("app");
  const consent = await request.put(`${apiOrigin}/v1/analytics/consent`, {
    headers: sessionHeaders,
    data: { state: "denied" },
  });
  expect(consent.status(), await consent.text()).toBe(200);

  await request.storageState({ path: adminStatePath });
  return adminStatePath;
}

async function evidence(page: Page, testInfo: TestInfo, name: string, mask: string[] = []) {
  await page.screenshot({
    path: `${evidenceDir}${testInfo.project.name}-${name}.png`,
    animations: "disabled",
    caret: "hide",
    mask: mask.map((selector) => page.locator(selector)),
  });
}

/** An address of its own per project, so the parallel runs never share OTP or redemption limits. */
function memberEmail(testInfo: TestInfo): string {
  return `maya+${testInfo.project.name}@example.test`;
}

/**
 * The project's own viewport for a context this spec opens itself, so the phone and laptop runs really
 * are narrow (overall.md responsive rules).
 */
function viewportOptions(testInfo: TestInfo): Record<string, unknown> {
  const use = testInfo.project.use as Record<string, unknown>;
  const options: Record<string, unknown> = { baseURL: webOrigin };
  for (const key of ["viewport", "isMobile", "hasTouch", "deviceScaleFactor", "userAgent"]) {
    if (use[key] !== undefined) options[key] = use[key];
  }
  return options;
}

async function openAdmin(
  browser: Browser,
  request: APIRequestContext,
  testInfo: TestInfo,
): Promise<Page> {
  const state = await ensureAdminSession(request);
  const context = await browser.newContext({ ...viewportOptions(testInfo), storageState: state });
  return context.newPage();
}

/** The member's browser, kept across the serial tests so one sign-in covers the whole flow. */
let memberContext: BrowserContext | null = null;
let member: Page | null = null;

async function openMember(browser: Browser, testInfo: TestInfo): Promise<Page> {
  if (member) return member;
  memberContext = await browser.newContext(viewportOptions(testInfo));
  member = await memberContext.newPage();
  return member;
}

function signedInMember(): Page {
  if (!member) throw new Error("The member's browser was never opened");
  return member;
}

/** Opens an account's administration screen by searching for its address. */
async function openAccountDetail(admin: Page, email: string): Promise<void> {
  await admin.goto("/admin/accounts");
  await admin.getByLabel(/Search accounts/).fill(email);
  await admin.getByRole("button", { name: "Search" }).click();
  await admin.getByRole("link", { name: "Maya Rao" }).first().click();
  await expect(admin.getByRole("heading", { name: "Maya Rao" })).toBeVisible();
}

/** Generates one invite code through the administration screens and returns it. */
async function generateInvite(admin: Page, label: string): Promise<string> {
  await admin.goto("/admin/invites/new");
  await admin.getByLabel("Label or note").fill(label);
  await admin.getByRole("button", { name: "Generate codes" }).click();
  await expect(admin.getByRole("heading", { name: "Your code" })).toBeVisible();
  const code = await admin.locator('[data-slot="generated-codes"] code').first().innerText();
  expect(code).toMatch(/^SYM(-[A-Z2-7]{4}){8}$/);
  return code;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await ensureApi();
});

test.afterAll(async () => {
  await memberContext?.close();
  memberContext = null;
  member = null;
});

test.describe("beta access, end to end", () => {
  test("signs up, verifies, unlocks with an invite and reaches the workspace", async ({
    browser,
    request,
  }, testInfo) => {
    test.slow();
    const email = memberEmail(testInfo);
    const page = await openMember(browser, testInfo);
    const admin = await openAdmin(browser, request, testInfo);
    const code = await generateInvite(admin, `E2E ${testInfo.project.name}`);
    await evidence(admin, testInfo, "admin-invite-created", ['[data-slot="generated-codes"] code']);

    // A signed-out visitor always starts at the email entry (§5.1, the proxy's hint redirect).
    await page.goto("/now");
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByRole("heading", { name: "Sign in to Symplist" })).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "email-entry" });
    await evidence(page, testInfo, "email-entry");

    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();

    // An unknown address asks permission before anything is created (note 03).
    await expect(page.getByRole("heading", { name: "No account found" })).toBeVisible();
    await expect(page.getByText(/signing up never sends one/)).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "signup-confirmation" });
    await evidence(page, testInfo, "signup-confirmation");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "email-otp" });
    await evidence(page, testInfo, "email-otp");
    const challenge = await deliveredCode(request, email, "signup");
    await page.getByLabel(/digit code/).fill(challenge.code);

    // Verifying the email never admits the account (note 03).
    await expect(page).toHaveURL(/\/access$/);
    await expect(page.getByRole("heading", { name: "You're signed in" })).toBeVisible();
    await expect(page.getByLabel("Invite code")).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "beta-gate" });
    await evidence(page, testInfo, "beta-gate");

    // A wrong code says only that it cannot be used.
    await page.getByLabel("Invite code").fill("SYM-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH");
    await page.getByRole("button", { name: "Unlock account" }).click();
    await expect(page.getByText("That code can't be used")).toBeVisible();

    await page.getByLabel("Invite code").fill(code);
    await page.getByRole("button", { name: "Unlock account" }).click();

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole("heading", { name: "What should we call you?" })).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "onboarding-name" });
    await evidence(page, testInfo, "onboarding-name");
    await page.getByLabel("Name").fill("Maya Rao");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Connect what you use" })).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "onboarding-connections" });
    await evidence(page, testInfo, "onboarding-connections");
    await page.getByRole("button", { name: "Skip for now" }).click();

    await expect(page).toHaveURL(/\/now$/);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("button", { name: "Account menu, Maya Rao" })).toBeVisible();
    await evidence(page, testInfo, "workspace");

    // The invite now shows one seat used, and only the hint (admin_invites.md).
    await admin.goto("/admin/invites");
    const row = admin.locator("tr", { hasText: `E2E ${testInfo.project.name}` }).first();
    await expect(row).toContainText("1 of 1");
    await expect(row).toContainText("SYM-…-");
    await expect(admin.getByText(code)).toHaveCount(0);
    await expectNoAxeViolations(admin, testInfo, { label: "admin-invites" });
    await evidence(admin, testInfo, "admin-invites");
    await admin.context().close();
  });

  test("an administrator relocks access, and restoring it opens the app again", async ({
    browser,
    request,
  }, testInfo) => {
    test.slow();
    const email = memberEmail(testInfo);
    // The member's browser is still signed in and admitted from the previous test.
    const page = signedInMember();
    const admin = await openAdmin(browser, request, testInfo);
    await expect(page).toHaveURL(/\/now$/);

    await openAccountDetail(admin, email);
    await expectNoAxeViolations(admin, testInfo, { label: "admin-account" });
    await evidence(admin, testInfo, "admin-account");

    await admin.getByRole("button", { name: "Relock access" }).click();
    const relock = admin.getByRole("dialog");
    await expect(relock).toContainText(
      "Actions already completed outside Symplist can't be undone",
    );
    await relock.getByLabel("Reason").fill("End-to-end check of the relock path");
    await relock.getByRole("button", { name: "Relock access" }).click();
    await expect(admin.getByText("Access relocked.")).toBeVisible();

    // The member's open app is replaced by the paused screen, with no code field (access_revoked.md).
    await expect(page.getByRole("heading", { name: "Access is currently paused" })).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByLabel("Invite code")).toHaveCount(0);
    await expect(page.getByText("Your session was interrupted")).toBeVisible();
    await expectNoAxeViolations(page, testInfo, { label: "access-paused" });
    await evidence(page, testInfo, "access-paused");

    // Another invite can never bypass an administrator's decision (note 04).
    const second = await generateInvite(admin, `E2E bypass ${testInfo.project.name}`);
    await page.goto("/access");
    await expect(page).toHaveURL(/\/access\/paused$/);
    await expect(page.getByLabel("Invite code")).toHaveCount(0);
    expect(second).toMatch(/^SYM-/);

    // Generating the bypass code above left the administrator on the invite screens, so the account
    // has to be opened again before it can be restored.
    await openAccountDetail(admin, email);
    await admin.getByRole("button", { name: "Restore access" }).click();
    const restore = admin.getByRole("dialog");
    await restore.getByLabel("Reason").fill("End-to-end check of the restore path");
    await restore.getByRole("button", { name: "Restore access" }).click();
    await expect(admin.getByText("Access restored.")).toBeVisible();

    await page.getByRole("button", { name: "Check access" }).click();
    await expect(page).toHaveURL(/\/now$/, { timeout: 25_000 });
    await expect(page.getByRole("banner")).toBeVisible();
    await evidence(page, testInfo, "workspace-restored");

    // The activity log records both decisions, newest first, with the reasons kept private until asked.
    await admin.goto("/admin/activity");
    await expect(admin.getByText(/restored access/).first()).toBeVisible();
    await expect(admin.getByText(/relocked access/).first()).toBeVisible();
    await expectNoAxeViolations(admin, testInfo, { label: "admin-activity" });
    await evidence(admin, testInfo, "admin-activity");
    await admin.context().close();
  });

  // This case drives the member page the suite already signed in, not a fresh fixture page. It took
  // no fixture and named `testInfo` second, which Playwright refuses at load ("first argument must
  // use the object destructuring pattern") — and that refusal failed the whole file before a single
  // case ran. A case that wants no fixture declares no parameters and asks for its info instead.
  test("the profile menu signs out and returns to the email entry", async () => {
    const testInfo = test.info();
    test.slow();
    const page = signedInMember();
    await expect(page).toHaveURL(/\/now$/);

    await page.getByRole("button", { name: /Account menu/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Beta administration" })).toHaveCount(0);
    await evidence(page, testInfo, "profile-menu");
    await menu.getByRole("menuitem", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole("heading", { name: "Sign in to Symplist" })).toBeVisible();
    // The session is gone: the workspace address sends the visitor back to sign-in.
    await page.goto("/now");
    await expect(page).toHaveURL(/\/signin/);
  });
});
