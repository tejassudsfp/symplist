import {
  documentPublishResponseSchema,
  sharingArtifactSchema,
  sharingReleaseSchema,
} from "@symplist/contracts";
import {
  SharingGrants,
  SharingMaintenance,
  SharingReader,
  SharingRepository,
} from "@symplist/core/sharing";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
let sequence = 0;
const key = () => `sharing-test-${String(++sequence).padStart(16, "0")}`;
const marker = "PRIVATE-SHARING-MARKER-38c1";
async function fixture() {
  const app = await bootTestApp();
  apps.push(app);
  const owner = await app.createSignedInUser();
  const task = uuidv7();
  await app.db.run(
    sql(
      `INSERT INTO tasks (id, owner_id, collection, position, source, write_id, title_enc, created_at, updated_at) VALUES (:id, :owner, 'now', 'a0', 'user', :write, 'sym1.1.x.y', :now, :now)`,
      { id: task, owner: owner.id, write: uuidv7(), now: int(app.clock.now()) },
    ),
  );
  const save = await app.post(`/v1/tasks/${task}/document/commits`, {
    session: owner.session,
    idempotencyKey: key(),
    body: {
      baseRevision: null,
      markdown: `# Public section\n${marker}\n\n# Private section\nDo not export this section\n`,
    },
  });
  expect(save.status, save.text).toBe(201);
  const revision = documentPublishResponseSchema.parse(save.json()).revision;
  if (!revision) throw new Error("Missing revision");
  const snapshot = await app.post(`/v1/tasks/${task}/artifacts`, {
    session: owner.session,
    idempotencyKey: key(),
    body: { title: "Reviewed brief", revision },
  });
  expect(snapshot.status, snapshot.text).toBe(201);
  const artifact = sharingArtifactSchema.parse(snapshot.json());
  const release = (overrides: Record<string, unknown> = {}, idempotencyKey = key()) =>
    app.post(`/v1/artifacts/${artifact.id}/grants`, {
      session: owner.session,
      idempotencyKey,
      body: {
        mode: "link",
        expiresAt: app.clock.now() + 86_400_000,
        expectedHead: revision,
        ...overrides,
      },
    });
  return { app, owner, task, revision, artifact, release };
}
function path(url: string): string {
  const value = new URL(url);
  return `${value.pathname}${value.search}`;
}

describe("artifact release and owner authorization", () => {
  it("creates a pinned encrypted snapshot and a secret only once; lists, D1, R2 and logs never contain it", async () => {
    const { app, owner, task, artifact, release } = await fixture();
    const idempotency = key();
    const first = await release({}, idempotency);
    expect(first.status, first.text).toBe(201);
    const result = sharingReleaseSchema.parse(first.json());
    if (result.secretUnavailable) throw new Error("Secret missing");
    const raw = new URL(result.url).searchParams.get("key");
    expect(raw).toHaveLength(43);
    const replay = await release({}, idempotency);
    expect(replay.status, replay.text).toBe(200);
    expect(sharingReleaseSchema.parse(replay.json())).toEqual({
      grant: result.grant,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    const mismatch = await release({ expiresAt: app.clock.now() + 3_600_000 }, idempotency);
    expect(mismatch.status).toBe(422);
    expect(await app.scanDatabaseFor(raw ?? "MISSING")).toEqual([]);
    expect(app.scanObjectsFor(raw ?? "MISSING")).toEqual([]);
    expect(await app.scanDatabaseFor(marker)).toEqual([]);
    expect(app.scanObjectsFor(marker)).toEqual([]);
    expect(app.logs.text()).not.toContain(raw);
    const list = await app.get(`/v1/tasks/${task}/artifacts`, { session: owner.session });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(raw);
    expect(list.json()).toMatchObject({
      artifacts: [{ id: artifact.id }],
      grants: [{ id: result.grant.id }],
    });
    const readable = await app.get(path(result.url), { shareHost: true });
    expect(readable.status, readable.text).toBe(200);
    expect(readable.text).toContain(marker);
    expect(readable.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(readable.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(readable.text).not.toContain("<script");
  });
  it("private ids, other artifacts, API host, bearer credentials and cross-user release grant nothing", async () => {
    const { app, artifact, release, revision } = await fixture();
    const result = sharingReleaseSchema.parse((await release()).json());
    if (result.secretUnavailable) throw new Error("Secret missing");
    expect((await app.get(`/artifact/${artifact.id}`, { shareHost: true })).status).toBe(404);
    expect((await app.get(path(result.url))).status).toBe(404);
    expect(
      (await app.get(path(result.url).replace(artifact.id, uuidv7()), { shareHost: true })).status,
    ).toBe(404);
    const stranger = await app.createSignedInUser();
    expect(
      (await app.get(`/v1/artifacts/${artifact.id}`, { session: stranger.session })).status,
    ).toBe(404);
    expect(
      (
        await app.post(`/v1/artifacts/${artifact.id}/grants`, {
          session: stranger.session,
          idempotencyKey: key(),
          body: { mode: "link", expiresAt: app.clock.now() + 1000, expectedHead: revision },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.get(`/v1/artifacts/${artifact.id}`, {
          headers: { Authorization: "Bearer sym_unauthorized" },
        })
      ).status,
    ).toBe(401);
  });
  it("requires trusted origin, session-bound CSRF, explicit public confirmation and idempotency", async () => {
    const { app, owner, artifact, revision } = await fixture();
    const body = { mode: "link", expectedHead: revision, expiresAt: app.clock.now() + 1000 };
    for (const options of [
      { origin: null },
      { origin: app.config.ARTIFACT_ORIGIN },
      { csrf: null },
    ]) {
      expect(
        (
          await app.post(`/v1/artifacts/${artifact.id}/grants`, {
            session: owner.session,
            body,
            idempotencyKey: key(),
            ...options,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await app.post(`/v1/artifacts/${artifact.id}/grants`, { session: owner.session, body }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.post(`/v1/artifacts/${artifact.id}/grants`, {
          session: owner.session,
          idempotencyKey: key(),
          body: { ...body, mode: "public" },
        })
      ).status,
    ).toBe(400);
  });
  it("expiry and revocation work synchronously without cleanup", async () => {
    const { app, owner, artifact, release } = await fixture();
    const first = sharingReleaseSchema.parse((await release()).json());
    const second = sharingReleaseSchema.parse(
      (await release({ expiresAt: app.clock.now() + 1000 })).json(),
    );
    if (first.secretUnavailable || second.secretUnavailable) throw new Error("Secret missing");
    app.clock.advance(1001);
    expect((await app.get(path(second.url), { shareHost: true })).status).toBe(404);
    expect((await app.get(path(first.url), { shareHost: true })).status).toBe(200);
    expect(
      (
        await app.post(`/v1/artifacts/${artifact.id}/grants/${first.grant.id}/revoke`, {
          session: owner.session,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(201);
    const unavailable = await app.get(path(first.url), { shareHost: true });
    expect(unavailable.status).toBe(404);
    expect(unavailable.text).not.toContain("Reviewed brief");
  });
  it("a proposal exposes only ids, is bound to the exact mode and expires when its source changes", async () => {
    const { app, owner, artifact, release, revision, task } = await fixture();
    const service = app.inject<SharingGrants>(SharingGrants);
    const proposal = await service.propose(
      { kind: "user", userId: owner.id },
      {
        artifactId: artifact.id,
        expectedHead: revision,
        mode: "link",
        expiresAt: app.clock.now() + 86_400_000,
      },
      "proposal-id-1",
    );
    expect(Object.keys(proposal)).toEqual(["proposalId", "status"]);
    expect(
      (await release({ proposalId: proposal.proposalId, mode: "public", publicConfirmed: true }))
        .status,
    ).toBe(409);
    const edit = await app.post(`/v1/tasks/${task}/document/commits`, {
      session: owner.session,
      idempotencyKey: key(),
      body: { baseRevision: revision, markdown: "# Changed source\nNew content\n" },
    });
    expect(edit.status).toBe(201);
    expect((await release({ proposalId: proposal.proposalId })).status).toBe(409);
    const rows = await app.db.all(sql("SELECT id FROM share_grants"));
    expect(rows).toEqual([]);
  });
  it("public grants are distinct and cannot unlock the private/password route", async () => {
    const { app, artifact, release } = await fixture();
    const result = sharingReleaseSchema.parse(
      (await release({ mode: "public", publicConfirmed: true, expiresAt: null })).json(),
    );
    if (result.secretUnavailable) throw new Error("Secret missing");
    expect((await app.get(path(result.url), { shareHost: true })).status).toBe(200);
    const raw = await app.get(`${path(result.url)}/raw`, { shareHost: true });
    expect(raw.status).toBe(200);
    expect(raw.text).toContain(marker);
    expect(raw.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(
      (await app.get(`/artifact/${artifact.id}?key=${result.grant.id}`, { shareHost: true }))
        .status,
    ).toBe(404);
  });
});

describe("password grants", () => {
  it("requires a bound nonce, uses a Secure HttpOnly session, protects raw text, and fences revocation", async () => {
    const { app, owner, artifact, release } = await fixture();
    const released = sharingReleaseSchema.parse(
      (await release({ mode: "password", password: "calm-private-password" })).json(),
    );
    if (released.secretUnavailable) throw new Error("Missing secret");
    const value = new URL(released.url).searchParams.get("key");
    const form = await app.get(path(released.url), { shareHost: true });
    expect(form.status).toBe(200);
    expect(form.text).toContain("A password is needed");
    expect(form.text).not.toContain(marker);
    const nonce = /name="nonce" value="([^"]+)"/.exec(form.text)?.[1];
    expect(nonce).toBeTruthy();
    const post = (password: string, formNonce = nonce) =>
      app.post(`/artifact/${artifact.id}/password`, {
        shareHost: true,
        origin: app.config.ARTIFACT_ORIGIN,
        body: { key: value, nonce: formNonce, password },
      });
    expect((await post("calm-private-password", "invalid")).status).toBe(404);
    const bad = await post("wrong password");
    expect(bad.status).toBe(403);
    expect(bad.text).toContain("did not work");
    const success = await post("calm-private-password");
    expect(success.status, success.text).toBe(303);
    const cookie = success.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-sym_share_");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    const rawPath = `/artifact/${artifact.id}/raw?key=${value}`;
    expect((await app.get(rawPath, { shareHost: true })).status).toBe(403);
    const unlocked = await app.get(rawPath, {
      shareHost: true,
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(unlocked.status, unlocked.text).toBe(200);
    expect(unlocked.text).toContain(marker);
    expect(await app.scanDatabaseFor("calm-private-password")).toEqual([]);
    await app.post(`/v1/artifacts/${artifact.id}/grants/${released.grant.id}/revoke`, {
      session: owner.session,
      idempotencyKey: key(),
    });
    expect(
      (await app.get(rawPath, { shareHost: true, headers: { cookie: cookie.split(";")[0] ?? "" } }))
        .status,
    ).toBe(404);
  });
  it("rechecks the exact password session after object storage returns", async () => {
    const { app, artifact, release } = await fixture();
    const released = sharingReleaseSchema.parse(
      (await release({ mode: "password", password: "calm-private-password" })).json(),
    );
    if (released.secretUnavailable) throw new Error("Missing secret");
    const value = new URL(released.url).searchParams.get("key");
    const form = await app.get(path(released.url), { shareHost: true });
    const nonce = /name="nonce" value="([^"]+)"/.exec(form.text)?.[1];
    const success = await app.post(`/artifact/${artifact.id}/password`, {
      shareHost: true,
      origin: app.config.ARTIFACT_ORIGIN,
      body: { key: value, nonce, password: "calm-private-password" },
    });
    expect(success.status, success.text).toBe(303);
    const cookie = success.headers.get("set-cookie")?.split(";")[0] ?? "";
    const get = app.objects.get.bind(app.objects);
    let revoked = false;
    vi.spyOn(app.objects, "get").mockImplementationOnce(async (objectKey) => {
      const stored = await get(objectKey);
      revoked = true;
      await app.db.run(
        sql(
          "UPDATE share_sessions SET revoked_at=:now,write_id=:write WHERE grant_id=:grant AND revoked_at IS NULL",
          {
            grant: released.grant.id,
            now: int(app.clock.now()),
            write: uuidv7(),
          },
        ),
      );
      return stored;
    });
    const raw = await app.get(`/artifact/${artifact.id}/raw?key=${value}`, {
      shareHost: true,
      headers: { cookie },
    });
    expect(revoked).toBe(true);
    expect(raw.status).toBe(404);
    expect(raw.text).not.toContain(marker);
  });
});

describe("adversarial sharing boundaries", () => {
  it("an exact release retry after its expiry returns only the redacted recorded outcome", async () => {
    const { app, release } = await fixture();
    const intent = key();
    const expiry = app.clock.now() + 1000;
    expect((await release({ expiresAt: expiry }, intent)).status).toBe(201);
    app.clock.advance(2000);
    const replay = await release({ expiresAt: expiry }, intent);
    expect(replay.status, replay.text).toBe(200);
    expect(replay.json()).toMatchObject({
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    expect(replay.text).not.toContain("?key=");
    expect((await release({ expiresAt: expiry })).status).toBe(422);
  });
  it("reads an exact bound proposal only as its owner and fences stale source on release", async () => {
    const { app, owner, task, artifact, revision, release } = await fixture();
    const proposal = await app.inject<SharingGrants>(SharingGrants).propose(
      {
        kind: "simon",
        userId: owner.id,
        taskId: task,
        runId: uuidv7(),
        mode: "task",
        conversationId: uuidv7(),
        toolCallId: "share-proposal",
        contextEpoch: 1,
      },
      {
        artifactId: artifact.id,
        mode: "link",
        expiresAt: app.clock.now() + 86400000,
        expectedHead: revision,
      },
      "proposal-review-test",
    );
    const read = await app.get(`/v1/share-proposals/${proposal.proposalId}`, {
      session: owner.session,
    });
    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({
      artifactId: artifact.id,
      mode: "link",
      expectedHead: revision,
      sourceChanged: false,
    });
    const other = await app.createSignedInUser();
    expect(
      (await app.get(`/v1/share-proposals/${proposal.proposalId}`, { session: other.session }))
        .status,
    ).toBe(404);
    expect((await release({ proposalId: proposal.proposalId })).status).toBe(201);
    expect((await release({ proposalId: proposal.proposalId })).status).toBe(409);
  });
  it("failed access guards leave neither a grant nor an idempotency success", async () => {
    const { app, owner, artifact, release } = await fixture();
    const repository = app.inject<SharingRepository>(SharingRepository);
    const original = repository.loadArtifact.bind(repository);
    vi.spyOn(repository, "loadArtifact").mockImplementationOnce(async (...args) => {
      const loaded = await original(...args);
      await app.db.run(
        sql("UPDATE artifacts SET deleted_at = :now WHERE id = :id", {
          now: int(app.clock.now()),
          id: artifact.id,
        }),
      );
      return loaded;
    });
    const intent = key();
    expect((await release({}, intent)).status).toBe(409);
    expect(
      await app.db.all(
        sql("SELECT id FROM share_grants WHERE owner_id = :owner", { owner: owner.id }),
      ),
    ).toEqual([]);
    expect(
      await app.db.all(
        sql("SELECT key FROM idempotency_records WHERE user_id = :owner AND key = :key", {
          owner: owner.id,
          key: intent,
        }),
      ),
    ).toEqual([]);
  });
  it("account keys and access are rechecked on every read, even for a known public grant", async () => {
    const { app, owner, release } = await fixture();
    const released = sharingReleaseSchema.parse(
      (await release({ mode: "public", publicConfirmed: true, expiresAt: null })).json(),
    );
    if (released.secretUnavailable) throw new Error("Missing URL");
    expect((await app.get(path(released.url), { shareHost: true })).status).toBe(200);
    await app.db.run(
      sql("UPDATE users SET suspended_at = :now WHERE id = :id", {
        now: int(app.clock.now()),
        id: owner.id,
      }),
    );
    expect((await app.get(path(released.url), { shareHost: true })).status).toBe(404);
    await app.db.run(sql("UPDATE users SET suspended_at = NULL WHERE id = :id", { id: owner.id }));
    await app.db.run(sql("DELETE FROM account_keys WHERE owner_id = :id", { id: owner.id }));
    expect((await app.get(path(released.url), { shareHost: true })).status).toBe(404);
  });
  it.each(["grant revocation", "owner restriction"] as const)(
    "rechecks %s after object storage returns and before decrypting",
    async (change) => {
      const { app, owner, release } = await fixture();
      const released = sharingReleaseSchema.parse(
        (await release({ mode: "public", publicConfirmed: true, expiresAt: null })).json(),
      );
      if (released.secretUnavailable) throw new Error("Missing URL");
      const get = app.objects.get.bind(app.objects);
      let changed = false;
      vi.spyOn(app.objects, "get").mockImplementationOnce(async (objectKey) => {
        const stored = await get(objectKey);
        changed = true;
        if (change === "grant revocation") {
          await app.db.run(
            sql(
              "UPDATE share_grants SET status='revoked',generation=generation+1,write_id=:write WHERE id=:grant",
              { grant: released.grant.id, write: uuidv7() },
            ),
          );
        } else {
          await app.db.run(
            sql("UPDATE users SET suspended_at=:now WHERE id=:owner", {
              owner: owner.id,
              now: int(app.clock.now()),
            }),
          );
        }
        return stored;
      });
      const response = await app.get(path(released.url), { shareHost: true });
      expect(changed).toBe(true);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain(marker);
      expect(response.text).not.toContain("Reviewed brief");
    },
  );
  it("durable password limits survive a fresh reader; successful verification does not spend a failure", async () => {
    const { app, artifact, release } = await fixture();
    const released = sharingReleaseSchema.parse(
      (await release({ mode: "password", password: "right-password" })).json(),
    );
    if (released.secretUnavailable) throw new Error("Missing URL");
    const raw = new URL(released.url).searchParams.get("key") ?? "";
    const repo = app.inject<SharingRepository>(SharingRepository);
    let reader = new SharingReader(repo);
    const page = await reader.read({ artifactId: artifact.id, key: raw });
    if (page.kind !== "password") throw new Error("Missing form");
    const input = {
      artifactId: artifact.id,
      key: raw,
      nonce: page.nonce,
      password: "right-password",
      ip: "203.0.113.10",
    };
    await reader.password(input);
    expect(
      (await app.db.first(sql("SELECT SUM(attempts) AS attempts FROM share_limits")))?.attempts,
    ).toBe(0);
    for (let i = 0; i < 5; i += 1)
      await expect(reader.password({ ...input, password: "wrong" })).rejects.toMatchObject({
        code: "sharing.password_invalid",
      });
    reader = new SharingReader(repo);
    await expect(reader.password(input)).rejects.toMatchObject({ code: "rate.limited" });
    expect(await app.scanDatabaseFor(input.ip)).toEqual([]);
  });
  it("one hundred concurrent attempts cannot overspend either durable password counter", async () => {
    const { app, artifact, release } = await fixture();
    const released = sharingReleaseSchema.parse(
      (await release({ mode: "password", password: "right-password" })).json(),
    );
    if (released.secretUnavailable) throw new Error("Missing URL");
    const raw = new URL(released.url).searchParams.get("key") ?? "";
    const reader = app.inject<SharingReader>(SharingReader);
    const page = await reader.read({ artifactId: artifact.id, key: raw });
    if (page.kind !== "password") throw new Error("Missing form");
    await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        reader.password({
          artifactId: artifact.id,
          key: raw,
          nonce: page.nonce,
          password: "wrong",
          ip: "203.0.113.11",
        }),
      ),
    );
    const rows = await app.db.all(
      sql("SELECT bucket, attempts FROM share_limits WHERE grant_id = :grant", {
        grant: released.grant.id,
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => Number(row.attempts) <= 5)).toBe(true);
    expect(rows.find((row) => row.bucket === "all")?.attempts).toBe(5);
  });
  it("serves only allowlisted self-hosted font assets on the share hostname", async () => {
    const { app } = await fixture();
    const font = await app.get("/artifact/_assets/geist-latin-wght-normal.woff2", {
      shareHost: true,
    });
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toContain("font/woff2");
    expect(font.headers.get("cache-control")).toBe("private, no-store");
    expect((await app.get("/artifact/_assets/geist-latin-wght-normal.woff2")).status).toBe(404);
    expect((await app.get("/artifact/_assets/package.json", { shareHost: true })).status).toBe(404);
  });
  it("malformed ids stay generic and early share-host validation failures keep privacy headers", async () => {
    const { app, artifact } = await fixture();
    const read = await app.get("/artifact/not-an-id?key=unknown", { shareHost: true });
    expect(read.status).toBe(404);
    expect(read.text).toContain("This artifact is unavailable");
    const form = await app.post(`/artifact/${artifact.id}/password`, {
      shareHost: true,
      origin: "https://wrong.example",
      body: {},
    });
    expect(form.status).toBe(403);
    expect(form.headers.get("cache-control")).toBe("private, no-store");
    expect(form.headers.get("referrer-policy")).toBe("no-referrer");
    expect(form.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
  it("maintenance deletes old unreferenced ciphertext but preserves referenced snapshots", async () => {
    const { app, owner, artifact } = await fixture();
    const maintenance = new SharingMaintenance(app.db, app.objects);
    const orphan = `u/${owner.id}/artifacts/${uuidv7()}.md.sym`;
    await app.objects.put({ key: orphan, body: new Uint8Array([1, 2, 3]) });
    const old = Date.now() + 2 * 86400000;
    const result = await maintenance.collectOwner(owner.id, old);
    expect(result.deleted).toBe(1);
    expect(await app.objects.get(orphan)).toBeNull();
    expect(await app.objects.get(`u/${owner.id}/artifacts/${artifact.id}.md.sym`)).not.toBeNull();
    await maintenance.sweep(app.clock.now());
  });
});
