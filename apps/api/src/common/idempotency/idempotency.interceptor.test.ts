import { decryptFieldText, idempotencyResponseContext } from "@symplist/crypto";
import { type MigrationTarget, sql } from "@symplist/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";
import {
  IdempotencyProbeModule,
  idempotencyProbe,
  leakedSecret,
} from "../../../test/probes/idempotency.probe.ts";
import { IDEMPOTENCY_REPLAYED_HEADER } from "./idempotency.interceptor.ts";

let app: TestApp;
let session: TestSession;
let userId: string;

beforeAll(async () => {
  app = await bootTestApp({ imports: [IdempotencyProbeModule] });
  await (app.db as MigrationTarget).executeScript(
    "CREATE TABLE IF NOT EXISTS probe_effects (label TEXT NOT NULL) STRICT;",
  );
  const user = await app.createSignedInUser();
  session = user.session;
  userId = user.id;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  idempotencyProbe.reset();
});

let keySequence = 0;
function freshKey(): string {
  keySequence += 1;
  return `test-key-${Date.now()}-${keySequence}-abcdef`;
}
const codeOf = (response: { json<T>(): T }) =>
  response.json<{ error: { code: string } }>().error.code;
const effects = () => idempotencyProbe.effects;

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Idempotency-Key interceptor (§6.1)", () => {
  it("requires a well-formed Idempotency-Key before running the handler", async () => {
    const missing = await app.post("/v1/idem/tasks/now", { session, body: { title: "A" } });
    expect(missing.status).toBe(400);
    expect(codeOf(missing)).toBe("idempotency.key_required");
    for (const key of ["short", "has spaces in it here!!", "x".repeat(129)]) {
      const invalid = await app.post("/v1/idem/tasks/now", {
        session,
        body: { title: "A" },
        idempotencyKey: key,
      });
      expect(codeOf(invalid)).toBe("idempotency.key_invalid");
    }
    expect(effects()).toEqual([]);
  });

  it("replays the exact recorded response for an exact retry without running the handler again", async () => {
    const key = freshKey();
    const request = { session, body: { title: "Plan trip" }, idempotencyKey: key };
    const first = await app.post("/v1/idem/tasks/now", request);
    expect(first.status).toBe(201);
    const retry = await app.post("/v1/idem/tasks/now", request);
    expect(retry.status).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER.toLowerCase())).toBe("true");
    expect(effects()).toEqual(["create:now:Plan trip"]);
  });

  it("fingerprints the validated input, so equivalent bodies replay and different ones mismatch", async () => {
    const key = freshKey();
    await app.post("/v1/idem/tasks/now", {
      session,
      body: { title: "Plan trip" },
      idempotencyKey: key,
    });
    const trimmed = await app.post("/v1/idem/tasks/now", {
      session,
      body: { title: "  Plan trip " },
      idempotencyKey: key,
    });
    expect(trimmed.status).toBe(201);
    const otherBody = await app.post("/v1/idem/tasks/now", {
      session,
      body: { title: "Other" },
      idempotencyKey: key,
    });
    expect(otherBody.status).toBe(422);
    expect(codeOf(otherBody)).toBe("idempotency.mismatch");
    // The route parameter is part of the validated input under the same route template.
    const otherParam = await app.post("/v1/idem/tasks/later", {
      session,
      body: { title: "Plan trip" },
      idempotencyKey: key,
    });
    expect(otherParam.status).toBe(422);
    expect(effects()).toEqual(["create:now:Plan trip"]);
  });

  it("returns validation errors from the interceptor exactly as the pipe would", async () => {
    const response = await app.post("/v1/idem/tasks/nowhere", {
      session,
      body: { title: "" },
      idempotencyKey: freshKey(),
    });
    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe("validation");
    expect(effects()).toEqual([]);
  });

  it("keeps keys separate per user", async () => {
    const other = await app.createSignedInUser();
    const key = freshKey();
    await app.post("/v1/idem/tasks/now", { session, body: { title: "Mine" }, idempotencyKey: key });
    const theirs = await app.post("/v1/idem/tasks/now", {
      session: other.session,
      body: { title: "Mine" },
      idempotencyKey: key,
    });
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get(IDEMPOTENCY_REPLAYED_HEADER.toLowerCase())).toBeNull();
    expect(effects()).toHaveLength(2);
  });

  it("answers idempotency.in_progress while the first request runs", async () => {
    const key = freshKey();
    const first = app.post("/v1/idem/slow", { session, body: {}, idempotencyKey: key });
    await waitFor(() => idempotencyProbe.release !== undefined);
    const concurrent = await app.post("/v1/idem/slow", { session, body: {}, idempotencyKey: key });
    expect(concurrent.status).toBe(409);
    expect(codeOf(concurrent)).toBe("idempotency.in_progress");
    idempotencyProbe.release?.();
    expect((await first).status).toBe(201);
    expect(effects()).toEqual(["slow"]);
  });

  it("releases the key after a client error so a retry runs the handler again", async () => {
    const key = freshKey();
    const request = { session, body: { attempt: 1 }, idempotencyKey: key };
    expect(codeOf(await app.post("/v1/idem/conflict", request))).toBe("task.archived");
    expect(codeOf(await app.post("/v1/idem/conflict", request))).toBe("task.archived");
    expect(effects()).toEqual(["conflict:1", "conflict:1"]);
  });

  it("stores the response only as an encrypted envelope bound to the record", async () => {
    const key = freshKey();
    const response = await app.post("/v1/idem/tasks/later", {
      session,
      body: { title: "Envelope marker 51c2" },
      idempotencyKey: key,
    });
    const row = await app.db.first(
      sql("SELECT scope, key, response_enc FROM idempotency_records WHERE key = :key", { key }),
    );
    expect(row?.scope).toBe("POST /v1/idem/tasks/:list");
    expect(String(row?.response_enc)).toMatch(/^sym1\./);
    expect(await app.scanDatabaseFor("Envelope marker 51c2")).toEqual([]);
    const plaintext = decryptFieldText(
      await app.accountKeys.require(userId),
      idempotencyResponseContext(userId, "POST /v1/idem/tasks/:list", key),
      String(row?.response_enc),
    );
    expect(JSON.parse(plaintext)).toEqual({ status: 201, body: response.json() });
  });

  it("fingerprints the raw body of a handler that declares no @Body, so another body mismatches", async () => {
    const key = freshKey();
    const first = await app.post("/v1/idem/raw", {
      session,
      body: { amount: 1 },
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const replay = await app.post("/v1/idem/raw", {
      session,
      body: { amount: 1 },
      idempotencyKey: key,
    });
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER.toLowerCase())).toBe("true");
    const other = await app.post("/v1/idem/raw", {
      session,
      body: { amount: 2 },
      idempotencyKey: key,
    });
    expect(other.status).toBe(422);
    expect(codeOf(other)).toBe("idempotency.mismatch");
    expect(effects()).toEqual(["raw:1"]);
  });

  it("replays the status the handler chose, not the method default", async () => {
    const key = freshKey();
    const first = await app.post("/v1/idem/accepted", { session, body: {}, idempotencyKey: key });
    expect(first.status).toBe(202);
    const retry = await app.post("/v1/idem/accepted", { session, body: {}, idempotencyKey: key });
    expect(retry.status).toBe(202);
    expect(retry.json()).toEqual(first.json());
    expect(effects()).toEqual(["accepted"]);
  });

  it("lets a handler fold the completion into its own batch", async () => {
    const key = freshKey();
    const first = await app.post("/v1/idem/folded", { session, body: {}, idempotencyKey: key });
    expect(first.status).toBe(201);
    const retry = await app.post("/v1/idem/folded", { session, body: {}, idempotencyKey: key });
    expect(retry.json()).toEqual({ folded: true });
    expect(effects()).toEqual(["folded"]);
    expect(await app.db.all(sql("SELECT label FROM probe_effects"))).toEqual([{ label: "folded" }]);
  });
});

describe("folding the claim into the deciding batch (§3.1, §6.1)", () => {
  const labels = async () =>
    (await app.db.all<{ label: string }>(sql("SELECT label FROM probe_effects"))).map(
      (row) => row.label,
    );

  beforeEach(async () => {
    await app.db.run(sql("DELETE FROM probe_effects"));
  });

  it("claims, applies the effect and records the response in the handler's single batch", async () => {
    const key = freshKey();
    const batch = vi.spyOn(app.db, "batch");
    const first = await app.post("/v1/idem/labels", {
      session,
      body: { label: "urgent" },
      idempotencyKey: key,
    });
    // One request reads the handler's account key; the claim, effect and completion are the other.
    expect(batch).toHaveBeenCalledTimes(2);
    const folded = batch.mock.calls[1]?.[0] ?? [];
    expect(folded.map((statement) => statement.sql.trim().split(/\s+/)[0])).toEqual([
      "INSERT",
      "SELECT",
      "INSERT",
      "UPDATE",
    ]);
    batch.mockRestore();
    expect(first.status).toBe(201);
    expect(first.json()).toEqual({ label: "urgent" });
    expect(first.headers.get(IDEMPOTENCY_REPLAYED_HEADER.toLowerCase())).toBeNull();
    const row = await app.db.first(
      sql("SELECT status, http_status FROM idempotency_records WHERE key = :key", { key }),
    );
    expect(row).toEqual({ status: "completed", http_status: 201 });
    expect(await labels()).toEqual(["urgent"]);
  });

  it("replays an exact retry without a second effect and refuses another input under the key", async () => {
    const key = freshKey();
    const request = { session, body: { label: "home" }, idempotencyKey: key };
    await app.post("/v1/idem/labels", request);
    const retry = await app.post("/v1/idem/labels", request);
    expect(retry.status).toBe(201);
    expect(retry.json()).toEqual({ label: "home" });
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER.toLowerCase())).toBe("true");
    const other = await app.post("/v1/idem/labels", {
      session,
      body: { label: "work" },
      idempotencyKey: key,
    });
    expect(other.status).toBe(422);
    expect(codeOf(other)).toBe("idempotency.mismatch");
    expect(await labels()).toEqual(["home"]);
    expect(effects()).toEqual(["label:home"]);
  });

  it("applies the effect exactly once when identical requests race", async () => {
    const key = freshKey();
    const request = { session, body: { label: "race" }, idempotencyKey: key };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.post("/v1/idem/labels", request)),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect(
      responses.filter((response) => response.headers.get("idempotency-replayed") === "true"),
    ).toHaveLength(4);
    expect(await labels()).toEqual(["race"]);
  });

  it("claims nothing for invalid input and fails closed when a handler never folds its claim", async () => {
    const invalid = await app.post("/v1/idem/labels", {
      session,
      body: { label: "" },
      idempotencyKey: freshKey(),
    });
    expect(codeOf(invalid)).toBe("validation");

    const key = freshKey();
    const forgotten = await app.post("/v1/idem/labels/forgotten", {
      session,
      body: { label: "lost" },
      idempotencyKey: key,
    });
    expect(forgotten.status).toBe(500);
    expect(app.logs.events("idempotency.fold_incomplete")).toHaveLength(1);
    expect(
      await app.db.first(
        sql("SELECT COUNT(*) AS n FROM idempotency_records WHERE key = :key", { key }),
      ),
    ).toEqual({ n: 0 });

    // A route that is not folded has no folded claim to use.
    const unfolded = await app.post("/v1/idem/labels/unfolded", {
      session,
      body: {},
      idempotencyKey: freshKey(),
    });
    expect(unfolded.status).toBe(500);
    expect(await labels()).toEqual([]);
  });
});

describe("one-time secrets are never replayable (§6.1, decision R11)", () => {
  it("returns the secret once, replays only the redacted outcome, and never writes it to D1, objects or logs", async () => {
    const key = freshKey();
    const request = { session, body: { label: "laptop" }, idempotencyKey: key };
    const first = await app.post("/v1/idem/keys", request);
    expect(first.status).toBe(201);
    const minted = first.json<{
      apiKey: string;
      grantId: string;
      hint: string;
      secretUnavailable: boolean;
    }>();
    expect(minted.secretUnavailable).toBe(false);
    expect(idempotencyProbe.mintedSecrets).toEqual([minted.apiKey]);

    const retry = await app.post("/v1/idem/keys", request);
    expect(retry.status).toBe(200);
    expect(retry.json()).toEqual({
      grantId: minted.grantId,
      hint: minted.hint,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    expect(retry.text).not.toContain(minted.apiKey);
    expect(effects()).toEqual(["mint:laptop"]);

    expect(await app.scanDatabaseFor(minted.apiKey)).toEqual([]);
    expect(app.scanObjectsFor(minted.apiKey)).toEqual([]);
    expect(app.logs.text()).not.toContain(minted.apiKey);
    const row = await app.db.first(
      sql("SELECT scope, response_enc FROM idempotency_records WHERE key = :key", { key }),
    );
    const plaintext = decryptFieldText(
      await app.accountKeys.require(userId),
      idempotencyResponseContext(userId, String(row?.scope), key),
      String(row?.response_enc),
    );
    expect(plaintext).not.toContain(minted.apiKey);
    expect(JSON.parse(plaintext).body).toMatchObject({ secretUnavailable: true });
  });

  it("fails the request instead of recording a secret repeated outside its declared field", async () => {
    const response = await app.post("/v1/idem/leaky", {
      session,
      body: {},
      idempotencyKey: freshKey(),
    });
    expect(response.status).toBe(500);
    expect(response.text).not.toContain(leakedSecret);
    expect(await app.scanDatabaseFor(leakedSecret)).toEqual([]);
    expect(app.logs.text()).not.toContain(leakedSecret);
  });
});
