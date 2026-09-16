import { randomBytes } from "node:crypto";
import { preferenceDefaults, preferenceGroups } from "@symplist/contracts";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountKeyStore } from "../account/keys.ts";
import {
  MemoryPreferencesCache,
  PreferencesAccessError,
  PreferencesService,
  PreferencesValidationError,
} from "./service.ts";

let clock = Date.UTC(2026, 8, 15, 9);
const now = () => clock;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;

async function insertUser(): Promise<string> {
  const id = uuidv7(clock);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'unlocked', 'done', :now, :now, :w)`,
      { id, email: `${id}@example.test`, now: int(clock), w: uuidv7(clock) },
    ),
    new AccountKeyStore({ db, keys }).provisionStatement({ userId: id, now: clock }),
  ]);
  return id;
}

function service(cache = true) {
  return new PreferencesService({
    db,
    keys,
    policy: { betaAccessRequired: true },
    now,
    ...(cache ? { cache: new MemoryPreferencesCache({ now }) } : {}),
  });
}

const violet = { themeId: "pebble", mode: "dark", accent: "violet" } as const;

beforeEach(async () => {
  clock = Date.UTC(2026, 8, 15, 9);
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  keys = createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      ]),
    ),
  );
});

afterEach(() => {
  db.close();
  keys.destroy();
});

describe("preferences (§10.3)", () => {
  it("stores each group in its own table and reads every group in one request", async () => {
    const owner = await insertUser();
    const preferences = service(false);
    clock += 1;
    await preferences.put({
      ownerId: owner,
      group: "appearance",
      baseVersion: 0,
      clientSeq: 1,
      data: violet,
    });
    clock += 1;
    const panels = {
      inboxCollapsed: true,
      chatCollapsed: false,
      inboxWidth: 320,
      chatWidth: null,
    };
    await preferences.put({
      ownerId: owner,
      group: "panels",
      baseVersion: 0,
      clientSeq: 1,
      data: panels,
    });

    // Migration 0202 adds `panels` in its own table rather than rewriting the foundation table's
    // CHECK, which would need a DROP and a RENAME (expand-only, §3.4).
    expect(
      await db.all<{ group: string }>(
        sql(`SELECT "group" FROM user_preferences WHERE owner_id = :owner`, { owner }),
      ),
    ).toEqual([{ group: "appearance" }]);
    expect(
      await db.all<{ group: string }>(
        sql(`SELECT "group" FROM user_preferences_panels WHERE owner_id = :owner`, { owner }),
      ),
    ).toEqual([{ group: "panels" }]);

    // Both tables are read together, so callers still see one uniform group set.
    const batch = vi.spyOn(db, "batch");
    const all = await service(false).getAll(owner);
    expect(batch).toHaveBeenCalledTimes(1);
    batch.mockRestore();
    expect(all.appearance).toMatchObject({ version: 1, data: violet });
    expect(all.panels).toMatchObject({ version: 1, data: panels });
    // A second save of the additive group still conflicts on its own version.
    clock += 1;
    const stale = await service(false).put({
      ownerId: owner,
      group: "panels",
      baseVersion: 0,
      clientSeq: 2,
      data: { ...panels, inboxWidth: 400 },
    });
    expect(stale).toMatchObject({ kind: "conflict", clientSeq: 2 });
    expect(stale.entry).toMatchObject({ version: 1, data: panels });
  });

  it("returns defaults at version 0 for every group, panels included", async () => {
    const owner = await insertUser();
    const all = await service().getAll(owner);
    for (const group of preferenceGroups) {
      expect(all[group]).toEqual({
        group,
        version: 0,
        data: preferenceDefaults[group],
        updatedAt: null,
      });
    }
  });

  it("saves at the base version, encrypted, and refuses stale saves with the current data", async () => {
    const owner = await insertUser();
    const phone = service(false);
    const laptop = service();
    const saved = await laptop.put({
      ownerId: owner,
      group: "appearance",
      baseVersion: 0,
      clientSeq: 1,
      data: violet,
    });
    expect(saved).toEqual({
      kind: "saved",
      entry: { group: "appearance", version: 1, data: violet, updatedAt: clock },
      clientSeq: 1,
      changed: true,
    });
    const stored = await db.first<{ data_enc: string }>(
      sql(`SELECT data_enc FROM user_preferences WHERE owner_id = :owner`, { owner }),
    );
    expect(stored?.data_enc.startsWith("sym1.")).toBe(true);
    expect(stored?.data_enc).not.toContain("pebble");

    // The phone saves on top of version 0 without knowing about the laptop's save.
    const stale = await phone.put({
      ownerId: owner,
      group: "appearance",
      baseVersion: 0,
      clientSeq: 7,
      data: { themeId: "studio", mode: "light", accent: "#2F9E44" },
    });
    expect(stale).toEqual({
      kind: "conflict",
      entry: { group: "appearance", version: 1, data: violet, updatedAt: clock },
      clientSeq: 7,
    });
    const next = await phone.put({
      ownerId: owner,
      group: "appearance",
      baseVersion: 1,
      clientSeq: 8,
      data: { themeId: "studio", mode: "light", accent: "#2F9E44" },
    });
    expect(next.kind).toBe("saved");
    expect(next.entry.version).toBe(2);
    // A later version than stored is also a conflict.
    const ahead = await phone.put({
      ownerId: owner,
      group: "appearance",
      baseVersion: 9,
      clientSeq: 9,
      data: violet,
    });
    expect(ahead.kind).toBe("conflict");
    expect(
      (
        await laptop.put({
          ownerId: owner,
          group: "panels",
          baseVersion: 0,
          clientSeq: 1,
          data: { inboxCollapsed: true, chatCollapsed: false, inboxWidth: 280, chatWidth: null },
        })
      ).kind,
    ).toBe("saved");
  });

  it("treats an exact retry of an applied save as saved without a second change", async () => {
    const owner = await insertUser();
    const prefs = service();
    const data = { overrides: { "workspace.complete": "shift+x" }, singleKeyShortcuts: false };
    await prefs.put({ ownerId: owner, group: "keyboard", baseVersion: 0, clientSeq: 3, data });
    const spy = vi.spyOn(db, "batch");
    const retry = await prefs.put({
      ownerId: owner,
      group: "keyboard",
      baseVersion: 0,
      clientSeq: 3,
      data,
    });
    expect(retry).toMatchObject({ kind: "saved", changed: false, entry: { version: 1, data } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("validates each group's data without echoing it", async () => {
    const owner = await insertUser();
    const prefs = service();
    const cases: Array<[Parameters<PreferencesService["put"]>[0]["group"], unknown]> = [
      ["appearance", { themeId: "Studio!", mode: "system", accent: "blue" }],
      ["appearance", { themeId: "studio", mode: "system", accent: "red; background: url(x)" }],
      ["keyboard", { overrides: { "Bad Id": "x" }, singleKeyShortcuts: true }],
      ["chat", { enterToSend: "yes", defaultTier: null }],
      ["recent", { taskIds: ["not-a-task"] }],
      [
        "panels",
        { inboxCollapsed: false, chatCollapsed: false, inboxWidth: 20_000, chatWidth: null },
      ],
      ["privacy", { includeChatInSearch: true, extra: 1 }],
    ];
    for (const [group, data] of cases) {
      const error = await prefs
        .put({ ownerId: owner, group, baseVersion: 0, clientSeq: 1, data })
        .catch((reason: unknown) => reason);
      expect(error, group).toBeInstanceOf(PreferencesValidationError);
      expect(JSON.stringify((error as PreferencesValidationError).issues)).not.toContain("url(x)");
      expect((error as PreferencesValidationError).issues[0]?.path[0]).toBe("data");
    }
    expect(await db.all(sql(`SELECT * FROM user_preferences`))).toEqual([]);
  });

  it("keeps owners apart and binds each envelope to its owner and group", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const prefs = service(false);
    await prefs.put({
      ownerId: owner,
      group: "appearance",
      baseVersion: 0,
      clientSeq: 1,
      data: violet,
    });
    await prefs.put({
      ownerId: owner,
      group: "privacy",
      baseVersion: 0,
      clientSeq: 1,
      data: { includeChatInSearch: true },
    });
    expect((await prefs.get(other, "appearance")).version).toBe(0);
    // Swapping ciphertext between groups or owners never decrypts.
    await db.run(
      sql(
        `UPDATE user_preferences SET data_enc = (SELECT data_enc FROM user_preferences WHERE owner_id = :owner AND "group" = 'appearance')
         WHERE owner_id = :owner AND "group" = 'privacy'`,
        { owner },
      ),
    );
    await expect(prefs.get(owner, "privacy")).rejects.toThrow();
  });

  it("refuses saves once access is taken away and follows data saved elsewhere", async () => {
    const owner = await insertUser();
    const prefs = service();
    await prefs.getAll(owner);
    await service(false).put({
      ownerId: owner,
      group: "chat",
      baseVersion: 0,
      clientSeq: 1,
      data: { enterToSend: true, defaultTier: "smart" },
    });
    // Within the TTL the cache serves the old value; a save reads the current row in its batch.
    expect((await prefs.get(owner, "chat")).version).toBe(0);
    const conflict = await prefs.put({
      ownerId: owner,
      group: "chat",
      baseVersion: 0,
      clientSeq: 2,
      data: { enterToSend: false, defaultTier: null },
    });
    expect(conflict).toMatchObject({
      kind: "conflict",
      entry: { version: 1, data: { enterToSend: true, defaultTier: "smart" } },
    });
    expect((await prefs.get(owner, "chat")).version).toBe(1);
    clock += 61_000;
    await db.run(
      sql(`UPDATE users SET suspended_at = :now WHERE id = :owner`, { now: int(clock), owner }),
    );
    const refused = await prefs
      .put({
        ownerId: owner,
        group: "chat",
        baseVersion: 1,
        clientSeq: 3,
        data: { enterToSend: false, defaultTier: null },
      })
      .catch((reason: unknown) => reason);
    expect(refused).toBeInstanceOf(PreferencesAccessError);
    expect((refused as PreferencesAccessError).code).toBe("access.suspended");
  });

  it("reads stored data of an older shape as the defaults at its version", async () => {
    const owner = await insertUser();
    const prefs = service(false);
    await prefs.put({
      ownerId: owner,
      group: "appearance",
      baseVersion: 0,
      clientSeq: 1,
      data: violet,
    });
    const key = await new AccountKeyStore({ db, keys }).require(owner);
    const { encryptFieldText } = await import("@symplist/crypto");
    const { preferencesContext } = await import("./service.ts");
    const legacy = encryptFieldText(
      key,
      preferencesContext(owner, "appearance"),
      JSON.stringify({ theme: "old" }),
    );
    await db.run(
      sql(`UPDATE user_preferences SET data_enc = :legacy WHERE owner_id = :owner`, {
        legacy,
        owner,
      }),
    );
    expect(await prefs.get(owner, "appearance")).toMatchObject({
      version: 1,
      data: preferenceDefaults.appearance,
    });
  });
});
