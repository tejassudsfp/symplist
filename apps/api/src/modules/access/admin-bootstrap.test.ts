import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeResponse } from "@symplist/contracts";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { signInWithCode, signUp } from "../../../test/access/helpers.ts";
import { bootTestApp, type TestApp, testApiEnv } from "../../../test/harness.ts";
import { parseAdminBootstrapArgs, runAdminBootstrapCli } from "./admin-bootstrap-cli.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(options: Parameters<typeof bootTestApp>[0] = {}): Promise<TestApp> {
  const app = await bootTestApp(options);
  apps.push(app);
  return app;
}

const bootstrapEvents = (app: TestApp) =>
  app.db.all(
    sql(`SELECT action, target_id, actor_kind FROM beta_admin_events WHERE action LIKE 'admin_%'`),
  );

describe("admin bootstrap (§5.7)", () => {
  it("promotes the configured address on its first verification, admits it, and never promotes signups", async () => {
    const app = await boot({ env: { ADMIN_BOOTSTRAP_EMAIL: "Owner@Example.test" } });
    const first = await signUp(app, "first.signup@example.test");
    expect(first.me.user.role).toBe("member");

    const owner = await signUp(app, "owner@example.test");
    expect(owner.me).toMatchObject({
      user: { role: "admin" },
      access: { betaState: "unlocked" },
      destination: "onboarding",
    });
    expect((await app.get("/v1/admin/invites", { session: owner.session })).status).toBe(200);
    expect(await bootstrapEvents(app)).toEqual([
      { action: "admin_bootstrap", target_id: owner.session.userId, actor_kind: "system" },
    ]);
    const grants = await app.db.all(
      sql(`SELECT source, actor_kind FROM beta_access_grants WHERE user_id = :u`, {
        u: owner.session.userId,
      }),
    );
    expect(grants).toEqual([{ source: "admin", actor_kind: "system" }]);
  });

  it("runs once: never re-promotes after a demotion, another admin, or on later sign-ins", async () => {
    const env = testApiEnv({ ADMIN_BOOTSTRAP_EMAIL: "owner@example.test" });
    const app = await boot({ env });
    const owner = await signUp(app, "owner@example.test");
    expect(owner.me.user.role).toBe("admin");
    await app.db.run(
      sql(`UPDATE users SET role = 'member' WHERE id = :u`, { u: owner.session.userId }),
    );
    await app.clock.advance(61_000);
    const again = await signInWithCode(app, "owner@example.test");
    expect(again.me.user.role).toBe("member");
    expect(await bootstrapEvents(app)).toHaveLength(1);
  });

  it("does not promote while another admin exists, or a relocked, suspended or unverified account", async () => {
    const app = await boot({ env: { ADMIN_BOOTSTRAP_EMAIL: "owner@example.test" } });
    await app.createUser({ state: "admin" });
    const owner = await signUp(app, "owner@example.test");
    expect(owner.me.user.role).toBe("member");

    for (const state of ["relocked", "suspended", "unverified"] as const) {
      const other = await boot({ env: { ADMIN_BOOTSTRAP_EMAIL: `${state}@example.test` } });
      const user = await other.createUser({ state, email: `${state}@example.test` });
      if (state !== "unverified") {
        const { me } = await signInWithCode(other, user.email);
        expect(me.user.role, state).toBe("member");
      }
      expect(await bootstrapEvents(other), state).toEqual([]);
    }
  });

  it("evaluates at startup and warns when the variable is still set after bootstrap was consumed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "symplist-bootstrap-"));
    try {
      const plain = await bootTestApp({ dataDir });
      const owner = await plain.createUser({ state: "locked", email: "owner@example.test" });
      await plain.close();

      const env = testApiEnv({ ADMIN_BOOTSTRAP_EMAIL: "owner@example.test" });
      const promoted = await bootTestApp({ env, dataDir });
      expect(await promoted.accessState(owner.id)).toMatchObject({
        role: "admin",
        betaState: "unlocked",
      });
      expect(promoted.logs.events("access.admin_bootstrapped")).toHaveLength(1);
      await promoted.close();

      const restarted = await bootTestApp({ env, dataDir });
      apps.push(restarted);
      expect(restarted.logs.events("access.admin_bootstrap_variable_still_set")).toHaveLength(1);
      expect(await bootstrapEvents(restarted)).toHaveLength(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("admin:bootstrap CLI (§5.7)", () => {
  it("parses the one-time and the forced forms and refuses anything else", () => {
    expect(parseAdminBootstrapArgs([])).toEqual({ force: false });
    expect(parseAdminBootstrapArgs(["--"])).toEqual({ force: false });
    const actor = "0192f0a0-0000-7000-8000-000000000001";
    expect(
      parseAdminBootstrapArgs([
        "--force-rebootstrap",
        "--actor",
        actor,
        "--reason",
        "Owner lost access",
      ]),
    ).toEqual({ force: true, actorId: actor, reason: "Owner lost access" });
    for (const argv of [
      ["--force"],
      ["--force-rebootstrap"],
      ["--force-rebootstrap", "--actor", "not-an-id", "--reason", "x"],
      ["--force-rebootstrap", "--actor", actor],
      ["--actor", actor, "--reason", "x"],
    ]) {
      expect(parseAdminBootstrapArgs(argv), argv.join(" ")).toBeNull();
    }
  });

  it("bootstraps once, reports a consumed bootstrap, and re-bootstraps only when forced with actor and reason", async () => {
    const env = testApiEnv({ ADMIN_BOOTSTRAP_EMAIL: "owner@example.test" });
    const app = await boot({ env });
    const owner = await app.createUser({ state: "locked", email: "owner@example.test" });
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      env: { ...env, LOCAL_DATA_DIR: app.dataDir },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      now: () => app.clock.now(),
      createDb: () => app.db,
      createKeys: () => app.keys,
    };
    expect(await runAdminBootstrapCli([], io)).toBe(0);
    expect(out.join("\n")).toContain(owner.id);
    expect(await app.accessState(owner.id)).toMatchObject({ role: "admin", betaState: "unlocked" });

    expect(await runAdminBootstrapCli([], io)).toBe(1);
    expect(err.join("\n")).toContain("already consumed");

    await app.db.run(sql(`UPDATE users SET role = 'member' WHERE id = :u`, { u: owner.id }));
    const actor = (await app.createUser({ state: "admin" })).id;
    expect(await runAdminBootstrapCli([], io)).toBe(1);
    expect(
      await runAdminBootstrapCli(
        ["--force-rebootstrap", "--actor", actor, "--reason", "Owner lost the role"],
        io,
      ),
    ).toBe(0);
    expect(await app.accessState(owner.id)).toMatchObject({ role: "admin" });
    const events = await app.db.all(
      sql(
        `SELECT action, actor_id, reason_enc FROM beta_admin_events WHERE action = 'admin_rebootstrap'`,
      ),
    );
    expect(events).toMatchObject([{ action: "admin_rebootstrap", actor_id: actor }]);
    expect(String(events[0]?.reason_enc)).toMatch(/^sym1\./);
    expect(await app.scanDatabaseFor("Owner lost the role")).toEqual([]);
    expect([...out, ...err].join("\n")).not.toContain("owner@example.test");

    const admin = await app.signIn(owner.id);
    expect((await app.get("/v1/me", { session: admin })).json<MeResponse>().user.role).toBe(
      "admin",
    );
  });

  it("exits 2 without ADMIN_BOOTSTRAP_EMAIL or with invalid configuration", async () => {
    const err: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => err.push(line) };
    expect(await runAdminBootstrapCli([], { ...io, env: testApiEnv() })).toBe(2);
    expect(await runAdminBootstrapCli([], { ...io, env: { NODE_ENV: "test" } })).toBe(2);
    expect(await runAdminBootstrapCli(["--bogus"], { ...io, env: testApiEnv() })).toBe(2);
  });
});
