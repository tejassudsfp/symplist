import { int, sql, uuidv7 } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { MaintenanceFence } from "../maintenance-fence.ts";
import { cleanupHourly } from "./cleanup.ts";
import { cleanupSharedFeatures } from "./feature-cleanup.ts";

describe("generation-fenced shared hourly cleanup", () => {
  let env: DocumentsTestEnvironment;
  let owner: string;
  let task: string;
  beforeEach(async () => {
    env = await createDocumentsTestEnvironment();
    owner = await env.createUser();
    task = await env.createTask(owner);
    await mode("local", 1);
  });
  afterEach(async () => env.close());
  async function mode(value: "local" | "durable", generation: number) {
    await env.db.run(
      sql(
        "INSERT INTO executor_state(id,mode,generation,updated_at,write_id) VALUES(1,:mode,:generation,0,'fixture') ON CONFLICT(id) DO UPDATE SET mode=:mode,generation=:generation",
        { mode: value, generation: int(generation) },
      ),
    );
  }
  function context(executor: "local" | "trigger" = "local", generation = 1, signal?: AbortSignal) {
    return {
      db: env.db,
      now: () => env.clock,
      fence: new MaintenanceFence(env.db, { executor, generation, ...(signal ? { signal } : {}) }),
    };
  }
  function objects() {
    return {
      put: env.objects.put.bind(env.objects),
      get: env.objects.get.bind(env.objects),
      head: env.objects.head.bind(env.objects),
      list: vi.fn<ObjectStore["list"]>(async () => ({ objects: [] })),
      delete: vi.fn<ObjectStore["delete"]>(async () => {}),
    };
  }
  function object(index: number, uploadedAt = env.clock - 2 * 86400000) {
    return {
      key: `u/${owner}/artifacts/00000000-0000-7000-8000-${String(index).padStart(12, "0")}.md.sym`,
      uploadedAt,
      size: 1,
      metadata: {},
    };
  }
  async function seedExpired() {
    const artifact = uuidv7(env.clock);
    await env.db.batch([
      sql(
        "INSERT INTO vaults(owner_id,parameters,pass_wrap_enc,recovery_wrap_enc,recovery_version,created_at,updated_at,write_id) VALUES(:owner,'{}','encrypted','encrypted',1,0,0,'seed')",
        { owner },
      ),
      sql(
        "INSERT INTO vault_items(id,owner_id,data_enc,created_at,updated_at,write_id) VALUES('item',:owner,'encrypted',0,0,'seed')",
        { owner },
      ),
      sql(
        "INSERT INTO vault_grants(id,owner_id,item_id,item_version,task_id,conversation_id,tool_slug,argument_path,label_enc,expires_at,status,value_enc,created_at,write_id) VALUES('grant',:owner,'item',1,:task,'conversation','tool','/value','encrypted',1,'active','encrypted',0,'seed')",
        { owner, task },
      ),
      sql(
        "INSERT INTO artifacts(id,owner_id,task_id,kind,title_enc,source_revision,selection_json,object_key,bytes,request_id,fingerprint_enc,created_at,write_id) VALUES(:id,:owner,:task,'document','encrypted','head','[]',:key,1,'fixture','encrypted',0,'seed')",
        { id: artifact, owner, task, key: object(1).key },
      ),
      sql(
        "INSERT INTO share_approvals(id,owner_id,artifact_id,expected_head,mode,password_required,request_id,fingerprint_enc,created_at,expires_at,write_id) VALUES('proposal',:owner,:artifact,'head','link',0,'fixture','encrypted',0,1,'seed')",
        { owner, artifact },
      ),
      sql(
        "INSERT INTO webhook_receipts(provider,receipt_id,received_at) VALUES('resend','old',0)",
        {},
      ),
    ]);
  }
  it.each(["local", "trigger"] as const)(
    "%s expires grants and proposals without touching live, young or foreign objects",
    async (executor) => {
      await mode(executor === "local" ? "local" : "durable", 1);
      await seedExpired();
      const store = objects();
      store.list.mockResolvedValue({
        objects: [
          object(1),
          object(2),
          object(3, env.clock),
          { ...object(4), key: "u/foreign/artifacts/object.md.sym" },
        ],
      });
      await cleanupHourly(
        {
          db: env.db,
          keys: env.keys,
          now: () => env.clock,
          policy: { betaAccessRequired: true },
          quickChatTtlHours: 24,
          cleanupFeatureExpiries: (_input, cleanup) => cleanupSharedFeatures(cleanup, store),
        },
        { executor, generation: 1 },
      );
      expect(
        await env.db.first(sql("SELECT status,value_enc FROM vault_grants WHERE id='grant'")),
      ).toEqual({ status: "expired", value_enc: null });
      expect(
        await env.db.first(sql("SELECT status FROM share_approvals WHERE id='proposal'")),
      ).toEqual({ status: "expired" });
      expect(await env.count("webhook_receipts")).toBe(0);
      expect(store.delete.mock.calls).toEqual([[object(2).key]]);
      expect(store.list).toHaveBeenCalledWith({ prefix: `u/${owner}/artifacts/`, limit: 100 });
    },
  );
  it("continues a stored opaque object cursor after a fresh runner and then advances owners", async () => {
    const second = await env.createUser();
    const owners = [owner, second].sort();
    const store = objects();
    store.list.mockResolvedValueOnce({ objects: [], cursor: "opaque-R2-next" });
    await cleanupSharedFeatures(context(), store);
    expect(
      await env.db.first(sql("SELECT owner_id,object_cursor,lease_until FROM cleanup_cursors")),
    ).toEqual({ owner_id: owners[0], object_cursor: "opaque-R2-next", lease_until: 0 });
    await cleanupSharedFeatures(context(), store);
    expect(store.list.mock.calls[1]?.[0]).toEqual({
      prefix: `u/${owners[0]}/artifacts/`,
      limit: 100,
      cursor: "opaque-R2-next",
    });
    await cleanupSharedFeatures(context(), store);
    expect(store.list.mock.calls[2]?.[0].prefix).toBe(`u/${owners[1]}/artifacts/`);
    await cleanupSharedFeatures(context(), store);
    expect(await env.db.first(sql("SELECT owner_id,object_cursor FROM cleanup_cursors"))).toEqual({
      owner_id: "",
      object_cursor: null,
    });
  });
  it("only one concurrent pass obtains the cursor lease", async () => {
    const store = objects();
    let release: (() => void) | undefined;
    store.list.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { objects: [] };
    });
    const first = cleanupSharedFeatures(context(), store);
    await vi.waitFor(() => expect(release).toBeDefined());
    await cleanupSharedFeatures(context(), store);
    expect(store.list).toHaveBeenCalledOnce();
    release?.();
    await first;
  });
  it("reclaims an abandoned lease after expiry without losing its saved object cursor", async () => {
    await env.db.run(
      sql(
        "INSERT INTO cleanup_cursors(id,owner_id,object_cursor,lease_token,lease_until,write_id) VALUES('artifacts',:owner,'saved-next','crashed',:until,'crashed')",
        { owner, until: int(env.clock + 300_000) },
      ),
    );
    const store = objects();
    await cleanupSharedFeatures(context(), store);
    expect(store.list).not.toHaveBeenCalled();
    env.clock += 300_001;
    await cleanupSharedFeatures(context(), store);
    expect(store.list).toHaveBeenCalledWith({
      prefix: `u/${owner}/artifacts/`,
      limit: 100,
      cursor: "saved-next",
    });
    expect(
      await env.db.first(sql("SELECT object_cursor,lease_until FROM cleanup_cursors")),
    ).toEqual({ object_cursor: null, lease_until: 0 });
  });
  it("bounds both expiry rows and a full object page within the worker request budget", async () => {
    await seedExpired();
    await env.db.run(
      sql(
        `WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<100)
      INSERT INTO vault_grants(id,owner_id,item_id,item_version,task_id,conversation_id,tool_slug,argument_path,label_enc,expires_at,status,value_enc,created_at,write_id)
      SELECT 'grant-'||n.value,:owner,'item',1,:task,'conversation','tool','/value','encrypted',1,'active','encrypted',0,'seed' FROM n`,
        { owner, task },
      ),
    );
    const store = objects();
    store.list.mockResolvedValue({
      objects: Array.from({ length: 100 }, (_, index) => object(index + 2)),
      cursor: "next-page",
    });
    const batch = vi.spyOn(env.db, "batch");
    await cleanupSharedFeatures(context(), store);
    expect(batch.mock.calls.length).toBeLessThanOrEqual(20);
    expect(store.list).toHaveBeenCalledOnce();
    expect(store.delete).toHaveBeenCalledTimes(100);
    expect(
      await env.db.first(sql("SELECT COUNT(*) AS count FROM vault_grants WHERE status='active'")),
    ).toEqual({ count: 1 });
    expect(
      await env.db.first(
        sql(
          "SELECT COUNT(*) AS count FROM vault_grants WHERE status='expired' AND value_enc IS NULL",
        ),
      ),
    ).toEqual({ count: 100 });
  });
  it.each(["mode", "generation", "abort", "lease"] as const)(
    "does not delete objects or advance a cursor after %s changes while R2 listing is in flight",
    async (change) => {
      const abort = new AbortController();
      const store = objects();
      store.list.mockImplementation(async () => {
        if (change === "mode") await mode("durable", 2);
        if (change === "generation") await mode("local", 2);
        if (change === "abort") abort.abort();
        if (change === "lease") env.clock += 300_001;
        return { objects: [object(2)], cursor: "must-not-advance" };
      });
      await cleanupSharedFeatures(context("local", 1, abort.signal), store);
      expect(store.delete).not.toHaveBeenCalled();
      expect(await env.db.first(sql("SELECT object_cursor FROM cleanup_cursors"))).toEqual({
        object_cursor: null,
      });
    },
  );
  it("stops between bounded object-delete groups and never starts a third group", async () => {
    const store = objects();
    store.list.mockResolvedValue({
      objects: Array.from({ length: 100 }, (_, index) => object(index)),
    });
    store.delete.mockImplementation(async () => {
      await mode("durable", 2);
    });
    await cleanupSharedFeatures(context(), store);
    expect(store.delete).toHaveBeenCalledTimes(10);
    expect(await env.db.first(sql("SELECT owner_id,object_cursor FROM cleanup_cursors"))).toEqual({
      owner_id: "",
      object_cursor: null,
    });
  });
  it("fences cleanup SQL at the write, not only its preliminary generation check", async () => {
    await seedExpired();
    const batch = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (statements.some((statement) => statement.sql.startsWith("UPDATE vault_grants"))) {
        await batch([sql("UPDATE executor_state SET generation=2 WHERE id=1")]);
      }
      return batch(statements, options);
    });
    const store = objects();
    await cleanupSharedFeatures(context(), store);
    expect(await env.db.first(sql("SELECT status,value_enc FROM vault_grants"))).toEqual({
      status: "active",
      value_enc: "encrypted",
    });
    expect(await env.db.first(sql("SELECT status FROM share_approvals"))).toEqual({
      status: "pending",
    });
    expect(store.list).not.toHaveBeenCalled();
  });
  it("stale or already-aborted execution never calls a feature callback", async () => {
    const cleanup = vi.fn(async () => {});
    const search = vi.fn(async () => {});
    const abort = new AbortController();
    abort.abort();
    const options = {
      db: env.db,
      keys: env.keys,
      now: () => env.clock,
      policy: { betaAccessRequired: true },
      quickChatTtlHours: 24,
      cleanupFeatureExpiries: cleanup,
      requeueSearch: search,
    };
    expect(await cleanupHourly(options, { executor: "trigger", generation: 1 })).toEqual({
      noop: true,
    });
    expect(
      await cleanupHourly(options, { executor: "local", generation: 1, signal: abort.signal }),
    ).toEqual({ noop: true });
    expect(cleanup).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});
