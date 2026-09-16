import {
  documentPublishResponseSchema,
  sharingArtifactSchema,
  sharingReleaseSchema,
} from "@symplist/contracts";
import { SharingGrants } from "@symplist/core/sharing";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { idempotencyKey } from "./access/helpers.ts";
import { bootTestApp, type TestApp, type TestResponse } from "./harness.ts";
import { assertSecretAbsent, issuedCookie } from "./secret-scan.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function fixture() {
  const app = await bootTestApp();
  apps.push(app);
  const owner = await app.createSignedInUser();
  const task = uuidv7();
  await app.db.run(
    sql(
      "INSERT INTO tasks(id,owner_id,collection,position,source,write_id,title_enc,created_at,updated_at) VALUES(:task,:owner,'now','a0','user','seed','sym1.1.x.y',:now,:now)",
      { task, owner: owner.id, now: int(app.clock.now()) },
    ),
  );
  const saved = await app.post(`/v1/tasks/${task}/document/commits`, {
    session: owner.session,
    idempotencyKey: idempotencyKey(),
    body: { baseRevision: null, markdown: "# Shared\nReviewed material only\n" },
  });
  expect(saved.status, saved.text).toBe(201);
  const revision = documentPublishResponseSchema.parse(saved.json()).revision;
  expect(revision).toBeTruthy();
  const snapshot = await app.post(`/v1/tasks/${task}/artifacts`, {
    session: owner.session,
    idempotencyKey: idempotencyKey(),
    body: { title: "Reviewed snapshot", revision },
  });
  expect(snapshot.status, snapshot.text).toBe(201);
  return {
    app,
    owner,
    task,
    revision: revision ?? "",
    artifact: sharingArtifactSchema.parse(snapshot.json()),
  };
}
function issued(response: TestResponse) {
  expect(response.status, response.text).toBe(201);
  const result = sharingReleaseSchema.parse(response.json());
  if (result.secretUnavailable) throw new Error("Mint must return its one-time URL");
  return result;
}

describe("§6.1 sharing endpoint secret scans", () => {
  it.each(["link", "password", "public", "proposal", "replacement"] as const)(
    "POST /artifacts/:id/grants (%s): release, duplicate and inventory respect the one-time boundary",
    async (variant) => {
      const { app, owner, task, revision, artifact } = await fixture();
      const path = `/v1/artifacts/${artifact.id}/grants`;
      const password = "fake-share-passphrase-scan-93bc";
      const body = {
        mode: variant === "password" ? "password" : variant === "public" ? "public" : "link",
        expectedHead: revision,
        expiresAt: variant === "public" ? null : app.clock.now() + 86400000,
        ...(variant === "password" ? { password } : {}),
        ...(variant === "public" ? { publicConfirmed: true } : {}),
      };
      const secrets: string[] = [];
      const addSecret = (result: ReturnType<typeof issued>) => {
        secrets.push(result.url);
        const token = new URL(result.url).searchParams.get("key");
        if (variant !== "public") {
          expect(token).toHaveLength(43);
          secrets.push(token ?? "");
        }
      };
      let extra: Record<string, unknown> = {};
      let previous: ReturnType<typeof issued> | undefined;
      if (variant === "replacement") {
        previous = issued(
          await app.post(path, { session: owner.session, body, idempotencyKey: idempotencyKey() }),
        );
        addSecret(previous);
        await assertSecretAbsent(app, secrets);
        extra = { replaceGrantId: previous.grant.id, revokeReplaced: true };
      }
      if (variant === "proposal") {
        const proposal = await app.inject<SharingGrants>(SharingGrants).propose(
          { kind: "user", userId: owner.id },
          {
            artifactId: artifact.id,
            expectedHead: revision,
            mode: "link",
            expiresAt: app.clock.now() + 86400000,
          },
          idempotencyKey(),
        );
        expect(Object.keys(proposal).sort()).toEqual(["proposalId", "status"]);
        extra = { proposalId: proposal.proposalId };
      }
      const options = {
        session: owner.session,
        body: { ...body, ...extra },
        idempotencyKey: idempotencyKey(),
      };
      const first = issued(await app.post(path, options));
      addSecret(first);
      if (variant === "password") secrets.push(password);
      await assertSecretAbsent(app, secrets);
      const replay = await app.post(path, options);
      const duplicate = await app.post(path, options);
      for (const response of [replay, duplicate]) {
        expect(response.status, response.text).toBe(200);
        expect(sharingReleaseSchema.parse(response.json())).toEqual({
          grant: first.grant,
          secretUnavailable: true,
          notice: "secret.already_issued",
        });
      }
      const inventory = await app.get(`/v1/tasks/${task}/artifacts`, { session: owner.session });
      expect(inventory.status, inventory.text).toBe(200);
      expect(inventory.json<{ grants: unknown[] }>().grants).toHaveLength(previous ? 2 : 1);
      const responses = [replay, duplicate, inventory];
      if (previous) {
        expect(first.url).not.toBe(previous.url);
        expect(
          await app.db.first(
            sql("SELECT status FROM share_grants WHERE id=:id", { id: previous.grant.id }),
          ),
        ).toEqual({ status: "revoked" });
      }
      const forged = await app.post(path, {
        ...options,
        body: { ...options.body, expiresAt: app.clock.now() + 7200000 },
      });
      expect(forged.status).toBe(422);
      responses.push(forged);
      expect(await assertSecretAbsent(app, secrets, responses)).toBeGreaterThanOrEqual(3);
    },
  );
  it("POST /artifact/:id/password: only Set-Cookie carries the issued session; reads and storage never carry it", async () => {
    const { app, owner, revision, artifact } = await fixture();
    const password = "fake-password-cookie-scan-437d";
    const release = issued(
      await app.post(`/v1/artifacts/${artifact.id}/grants`, {
        session: owner.session,
        idempotencyKey: idempotencyKey(),
        body: {
          mode: "password",
          password,
          expectedHead: revision,
          expiresAt: app.clock.now() + 86400000,
        },
      }),
    );
    const url = new URL(release.url);
    const token = url.searchParams.get("key") ?? "";
    const form = await app.get(`${url.pathname}${url.search}`, { shareHost: true });
    const nonce = /name="nonce" value="([^"]+)"/.exec(form.text)?.[1];
    expect(nonce).toBeTruthy();
    const unlocked = await app.post(`/artifact/${artifact.id}/password`, {
      shareHost: true,
      origin: app.config.ARTIFACT_ORIGIN,
      body: { key: token, nonce, password },
    });
    expect(unlocked.status, unlocked.text).toBe(303);
    const session = issuedCookie(unlocked, `__Host-sym_share_${release.grant.id}`);
    expect(unlocked.text).not.toContain(session.token);
    const readable = await app.get(`${url.pathname}/raw${url.search}`, {
      shareHost: true,
      headers: { cookie: session.cookie },
    });
    expect(readable.status).toBe(200);
    expect(readable.text).toContain("Reviewed material only");
    await assertSecretAbsent(app, [session.token, token, release.url, password], [readable]);
    // The password form necessarily includes the presented share key; it never contains the password
    // or newly minted session. Its bound nonce is a short-lived form capability, not a stored secret.
    expect(form.text).not.toContain(password);
    expect(form.text).not.toContain(session.token);
  });
});
