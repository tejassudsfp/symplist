import {
  documentPublishResponseSchema,
  sharingArtifactSchema,
  sharingReleaseSchema,
} from "@symplist/contracts";
import { SharingGrants } from "@symplist/core/sharing";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
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
});
