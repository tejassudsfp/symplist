/// <reference lib="dom" />
// Callbacks passed to page.evaluate run in the browser, so this spec needs the DOM types.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import {
  generatedSecretBytes,
  generatedSecretFamilies,
  secretFamilyInventory,
} from "../../../packages/config/src/secrets.ts";
import { expectNoAxeViolations } from "../src/helpers/index.ts";

/*
 * The access flows end to end (§5, notes 03 and 04): explicit signup consent, an emailed code, the
 * locked beta gate, an administrator generating an invite, redemption, onboarding and the workspace,
 * then a relock that blocks access and a restore that returns it. The api runs with local drivers and
 * `NODE_ENV=test`, so the suite reads the delivered code from the test-only outbox (decision AC12)
 * instead of a mailbox; codes still never appear in a response to anyone else.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const apiEntry = join(repoRoot, "apps", "api", "dist", "main.js");
const evidenceDir = fileURLToPath(new URL("../evidence/access/", import.meta.url));

const webOrigin =
  process.env.E2E_WEB_URL ?? `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 3000}`;
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
const adminEmail = "operator@example.test";

/** One api and one admin session per Playwright run, shared by every project's worker. */
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

/** A throwaway api environment: local drivers, generated secrets, data under the run directory. */
function apiEnvironment(dataDir: string): Record<string, string> {
  const families = Object.fromEntries(
    generatedSecretFamilies
      .filter((family) => secretFamilyInventory[family].api === "yes")
      .flatMap((family) => [
        [`${family}_1`, randomBytes(generatedSecretBytes).toString("base64url")],
        [`${family}_CURRENT`, "1"],
      ]),
  );
  const port = new URL(apiOrigin).port;
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    PORT: port,
    WEB_ORIGIN: webOrigin,
    API_ORIGIN: apiOrigin,
    WS_ORIGIN: apiOrigin.replace(/^http/, "ws"),
    // A different hostname from the api and web origins, as the share host must be (§16.3).
    ARTIFACT_ORIGIN: `http://localhost:${port}`,
    TRUST_PROXY_HOPS: "0",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    KEY_PROVIDER: "env",
    BETA_ACCESS_REQUIRED: "true",
    ADMIN_BOOTSTRAP_EMAIL: adminEmail,
    EMAIL_FROM_SECURITY: "Symplist <security@example.test>",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@example.test>",
    LOCAL_DATA_DIR: join(dataDir, ".local-data"),
    ...families,
  };
}

/**
 * Starts the api once per run. The first worker to take the lock spawns it through a supervisor that
 * stops it when the Playwright runner exits, so later workers find it already answering.
 */
async function ensureApi(): Promise<void> {
  if (await healthy()) return;
  if (!existsSync(apiEntry)) {
    throw new Error(`Missing ${apiEntry}. Run "pnpm build" before the end-to-end suite.`);
  }
  mkdirSync(runRoot, { recursive: true });
  let owner = false;
  try {
    mkdirSync(join(runRoot, "api.lock"));
    owner = true;
  } catch {
    owner = false;
  }
  if (owner) {
    const dataDir = mkdtempSync(join(runRoot, "api-"));
    const supervisor = join(dataDir, "supervise.mjs");
    writeFileSync(
      supervisor,
      [
        "import { spawn } from 'node:child_process';",
        "const [entry, runner] = process.argv.slice(2);",
        "const api = spawn(process.execPath, [entry], { stdio: 'inherit' });",
        "const timer = setInterval(() => {",
        "  try { process.kill(Number(runner), 0); } catch {",
        "    clearInterval(timer);",
        "    api.kill('SIGTERM');",
        "    setTimeout(() => process.exit(0), 3000);",
        "  }",
        "}, 1000);",
        "api.on('exit', (code) => { clearInterval(timer); process.exit(code ?? 0); });",
      ].join("\n"),
    );
    const child = spawn(process.execPath, [supervisor, apiEntry, String(process.ppid)], {
      cwd: dataDir,
      env: apiEnvironment(dataDir),
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await sleep(250);
  }
  throw new Error(`The api did not answer at ${apiOrigin}/healthz`);
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

    await admin.goto("/admin/accounts");
    await admin.getByLabel(/Search accounts/).fill(email);
    await admin.getByRole("button", { name: "Search" }).click();
    await admin.getByRole("link", { name: "Maya Rao" }).first().click();
    await expect(admin.getByRole("heading", { name: "Maya Rao" })).toBeVisible();
    await expectNoAxeViolations(admin, testInfo, { label: "admin-account" });
    await evidence(admin, testInfo, "admin-account");

    await admin.getByRole("button", { name: "Relock access" }).click();
    const relock = admin.getByRole("dialog");
    await expect(relock).toContainText("Actions already completed outside Symplist can't be undone");
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

    await admin.reload();
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

  test("the profile menu signs out and returns to the email entry", async ({}, testInfo) => {
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
