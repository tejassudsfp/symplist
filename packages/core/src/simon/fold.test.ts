import { randomBytes } from "node:crypto";
import { createKeyProvider, type ManagedKeyProvider, zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { IdempotencyStore } from "../idempotency/store.ts";
import { SimonApprovals } from "./approvals.ts";
import type { SimonWriteFold } from "./fold.ts";
import { SimonRepository } from "./repository.ts";
import { SimonError } from "./types.ts";
import { SimonUserAsks } from "./user-asks.ts";

let env: DocumentsTestEnvironment;
let keys: ManagedKeyProvider;
let store: IdempotencyStore;
let repository: SimonRepository;
let owner: string;
let task: string;
let conversation: string;
const input = { text: "message-private-marker", tier: "fast" as const };

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  keys = createKeyProvider(
    { IDEMPOTENCY_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) } },
    { required: ["IDEMPOTENCY_SECRET"] },
  );
  store = new IdempotencyStore({ db: env.db, keys });
  repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  await env.db.run(sql("UPDATE executor_state SET mode = 'local' WHERE id = 1"));
  owner = await env.createUser();
  task = await env.createTask(owner);
  conversation = await repository.createConversation(owner, task);
});
afterEach(async () => {
  vi.restoreAllMocks();
  keys?.destroy();
  await env?.close();
});

function fold(
  key: string,
  body: unknown = input,
  scope = "messages",
  userId = owner,
): SimonWriteFold {
  const request = { scope, userId, key, input: body, now: env.clock };
  const folded = store.foldedClaim(request);
  return {
    ...folded,
    completion: (response, accountKey) =>
      store.completeStatement({ claim: folded.claim, response, accountKey, now: env.clock }),
    decide: (results, accountKey, offset) => {
      const decision = store.decideFoldedClaim({ request, folded, results, accountKey, offset });
      if (decision.kind === "mismatch") throw new SimonError("idempotency.mismatch");
      if (decision.kind === "in_progress") throw new SimonError("idempotency.in_progress");
      return decision.kind === "replay"
        ? { kind: "replay", body: decision.response.body }
        : decision;
    },
  };
}
const send = (key = "first-message", body = input) =>
  repository.acceptMessage(owner, conversation, key, body, fold(key, body));

async function pendingApproval() {
  const sent = await repository.acceptMessage(owner, conversation, "approval-message", input);
  const claimed = await repository.claim(sent.runId ?? "", "local");
  if (!claimed) throw new Error("expected claim");
  const connectionId = uuidv7();
  await env.db.run(
    sql(
      `INSERT INTO connections (id, owner_id, toolkit, connected_account_id,
    status, confirmed_at, created_at, updated_at, write_id)
    VALUES (:id, :owner, 'gmail', 'ca_fold', 'active', :now, :now, :now, :id)`,
      { id: connectionId, owner, now: int(env.clock) },
    ),
  );
  const approvals = new SimonApprovals(repository);
  try {
    const id = await approvals.pause(
      claimed.run,
      claimed.key,
      {
        toolCallId: "send_1",
        toolSlug: "GMAIL_SEND_EMAIL",
        connection: {
          id: connectionId,
          ownerId: owner,
          toolkit: "gmail",
          connectedAccountId: "ca_fold",
          generation: 1,
          approvalMode: "all",
        },
        arguments: { body: "private-approval-marker" },
        preview: { body: "private-approval-marker" },
        policyVersion: "test.1",
      },
      { text: "Review send", steps: 1 },
    );
    const view = await approvals.load(owner, id);
    return { approvals, id, view, connectionId };
  } finally {
    zeroize(claimed.key.key);
  }
}

describe("folded approval decisions", () => {
  it.each(["approve", "deny", "dismiss"] as const)(
    "replays %s without a second continuation",
    async (decision) => {
      const { approvals, id, view } = await pendingApproval();
      const body = { decision, argDigest: view.argDigest };
      const decide = () =>
        approvals.decide(owner, id, body, undefined, fold("decision", body, "approvals"));
      const batch = vi.spyOn(env.db, "batch");
      const first = await decide();
      expect(batch).toHaveBeenCalledTimes(2);
      expect(await decide()).toEqual(first);
      expect(await env.count("runs")).toBe(2);
      expect(await env.count("idempotency_records")).toBe(1);
      await expect(
        approvals.decide(
          owner,
          id,
          { ...body, argDigest: "a".repeat(43) },
          undefined,
          fold("decision", { changed: true }, "approvals"),
        ),
      ).rejects.toMatchObject({ code: "idempotency.mismatch" });
    },
  );
  it("racing different keys have one winner and no dangling claim", async () => {
    const { approvals, id, view } = await pendingApproval();
    const body = { decision: "approve" as const, argDigest: view.argDigest };
    const results = await Promise.allSettled(
      ["a", "b", "c"].map((key) =>
        approvals.decide(owner, id, body, undefined, fold(key, body, "approvals")),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await env.count("runs")).toBe(2);
    expect(await env.count("idempotency_records")).toBe(1);
  });
  it("an edited draft creates a replayable fresh review and never dispatches", async () => {
    const { approvals, id, view } = await pendingApproval();
    const body = {
      decision: "approve" as const,
      argDigest: view.argDigest,
      editedArguments: { body: "edited-private-marker" },
    };
    const validator = vi.fn(
      async ({ editedArguments }: { editedArguments: Readonly<Record<string, unknown>> }) => ({
        arguments: editedArguments,
        preview: editedArguments,
        policyVersion: "test.2",
      }),
    );
    const decide = () =>
      approvals.decide(owner, id, body, validator, fold("edit", body, "approvals"));
    const first = await decide();
    expect(first).toMatchObject({ status: "pending", runId: view.runId });
    expect(first.approvalId).not.toBe(id);
    expect(await decide()).toEqual(first);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(await env.count("runs")).toBe(1);
    const fresh = await approvals.load(owner, first.approvalId);
    expect(fresh.arguments).toEqual(body.editedArguments);
    expect(fresh.argDigest).not.toBe(view.argDigest);
    expect((await approvals.load(owner, id)).status).toBe("superseded");
    const rows = await env.db.all(sql("SELECT arguments_enc, preview_enc FROM approvals"));
    expect(JSON.stringify(rows)).not.toContain("private-marker");
  });
  it("rolls back the decision and continuation when completion fails", async () => {
    const { approvals, id, view } = await pendingApproval();
    const body = { decision: "approve" as const, argDigest: view.argDigest };
    await expect(
      approvals.decide(owner, id, body, undefined, {
        ...fold("rollback", body, "approvals"),
        completion: () => sql("UPDATE missing_table SET value = 1 WHERE 1 = 1"),
      }),
    ).rejects.toThrow();
    expect((await approvals.load(owner, id)).status).toBe("pending");
    expect(await env.count("runs")).toBe(1);
    expect(await env.count("idempotency_records")).toBe(0);
  });
  it.each(["shred", "disconnect", "reconnect"])(
    "refuses %s between preparation and decision",
    async (change) => {
      const { approvals, id, view, connectionId } = await pendingApproval();
      const batch = env.db.batch.bind(env.db);
      vi.spyOn(env.db, "batch").mockImplementationOnce(async (...args) => {
        const result = await batch(...args);
        await env.db.run(
          change === "shred"
            ? sql("DELETE FROM account_keys WHERE owner_id = :owner", { owner })
            : sql(
                `UPDATE connections SET ${change === "disconnect" ? "status = 'disconnected'" : "generation = generation + 1"} WHERE id = :id`,
                { id: connectionId },
              ),
        );
        return result;
      });
      const body = { decision: "approve" as const, argDigest: view.argDigest };
      await expect(
        approvals.decide(owner, id, body, undefined, fold("race", body, "approvals")),
      ).rejects.toThrow();
      expect(await env.count("runs")).toBe(1);
      expect(await env.count("idempotency_records")).toBe(0);
      expect(
        (await env.db.first(sql("SELECT status FROM approvals WHERE id = :id", { id })))?.status,
      ).toBe("pending");
    },
  );
  it("refuses a recorded response after owner access is revoked", async () => {
    const { approvals, id, view } = await pendingApproval();
    const body = { decision: "approve" as const, argDigest: view.argDigest };
    await approvals.decide(owner, id, body, undefined, fold("replay", body, "approvals"));
    await env.relock(owner);
    await expect(
      approvals.decide(owner, id, body, undefined, fold("replay", body, "approvals")),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("refuses a recorded decision after task archive", async () => {
    const { approvals, id, view } = await pendingApproval();
    const body = { decision: "approve" as const, argDigest: view.argDigest };
    await approvals.decide(owner, id, body, undefined, fold("archive-replay", body, "approvals"));
    await env.archiveTask(task);
    await expect(
      approvals.decide(owner, id, body, undefined, fold("archive-replay", body, "approvals")),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("runs")).toBe(2);
  });
});

describe("Simon folded HTTP writes", () => {
  it("enforces an additional trusted authorization in the deciding batch and on replay", async () => {
    const authorization = {
      sql: "EXISTS (SELECT 1 FROM users WHERE id = :simon_auth_owner AND write_id = :simon_auth_generation)",
      params: { simon_auth_owner: owner, simon_auth_generation: "grant-generation-one" },
    };
    await env.db.run(
      sql("UPDATE users SET write_id = :w WHERE id = :owner", { owner, w: "grant-generation-one" }),
    );
    const scopedSend = () =>
      repository.acceptMessage(owner, conversation, "scoped", input, {
        ...fold("scoped"),
        authorization,
      });
    const first = await scopedSend();
    expect(await scopedSend()).toEqual(first);
    expect(await repository.run(owner, first.runId ?? "", authorization)).not.toBeNull();
    await env.db.run(
      sql("UPDATE users SET write_id = :w WHERE id = :owner", { owner, w: "revoked" }),
    );
    await expect(scopedSend()).rejects.toMatchObject({ code: "simon.stale" });
    expect(await repository.run(owner, first.runId ?? "", authorization)).toBeNull();
    await expect(
      repository.acceptMessage(owner, conversation, "new-scoped", input, {
        ...fold("new-scoped"),
        authorization,
      }),
    ).rejects.toMatchObject({ code: "simon.stale" });
    await expect(
      repository.createConversation(owner, null, {
        ...fold("scoped-create", {}, "conversations"),
        authorization,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("messages")).toBe(1);
    expect(await env.count("conversations")).toBe(1);
    expect(await env.count("idempotency_records")).toBe(1);
  });
  it("refuses authorization bind names that could shadow the operation's identity", async () => {
    const authorization = { sql: ":owner = :owner", params: { owner: "another-owner" } };
    await expect(
      repository.acceptMessage(owner, conversation, "shadow", input, {
        ...fold("shadow"),
        authorization,
      }),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(repository.run(owner, uuidv7(), authorization)).rejects.toMatchObject({
      code: "internal",
    });
    expect(await env.count("idempotency_records")).toBe(0);
  });
  it("rolls a question answer and its continuation back if recording the response fails", async () => {
    const first = await send();
    const claim = await repository.claim(first.runId ?? "", "local");
    if (!claim) throw new Error("Expected claim");
    const asks = new SimonUserAsks(repository);
    let askId: string;
    try {
      askId = await asks.pause(
        claim.run,
        claim.key,
        { question: "Which?", toolCallId: "ask_1" },
        { text: "Which?", steps: 1 },
      );
    } finally {
      repository.releaseClaim(claim);
    }
    const original = fold("answer", { text: "first" }, "answer");
    await expect(
      asks.decide(
        owner,
        askId,
        { kind: "answer", text: "first" },
        {
          ...original,
          completion: () => sql("UPDATE table_that_does_not_exist SET value = 1 WHERE 1 = 1"),
        },
      ),
    ).rejects.toThrow();
    expect((await asks.load(owner, askId)).status).toBe("pending");
    expect(await env.count("runs")).toBe(1);
    expect(await env.count("dispatch_intents")).toBe(1);
    expect(await env.count("idempotency_records")).toBe(1); // only the original message
  });
  it("cannot record a question answer after the key is shredded between preparation and commit", async () => {
    const first = await send();
    const claim = await repository.claim(first.runId ?? "", "local");
    if (!claim) throw new Error("Expected claim");
    const asks = new SimonUserAsks(repository);
    let askId: string;
    try {
      askId = await asks.pause(
        claim.run,
        claim.key,
        { question: "Which?", toolCallId: "ask_1" },
        { text: "Which?", steps: 1 },
      );
    } finally {
      repository.releaseClaim(claim);
    }
    const batch = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementationOnce(async (statements) => {
      const results = await batch(statements);
      await env.db.run(sql("DELETE FROM account_keys WHERE owner_id = :owner", { owner }));
      return results;
    });
    await expect(
      asks.decide(
        owner,
        askId,
        { kind: "answer", text: "first" },
        fold("answer", { text: "first" }, "answer"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await env.db.first(
        sql("SELECT status, answer_enc FROM user_asks WHERE id = :id", { id: askId }),
      ),
    ).toMatchObject({ status: "pending", answer_enc: null });
    expect(await env.count("runs")).toBe(1);
    expect(await env.count("idempotency_records")).toBe(1);
  });
  it("atomically records acceptance, encrypted response and dispatch in the same batch", async () => {
    const batch = vi.spyOn(env.db, "batch");
    const result = await send();
    expect(batch).toHaveBeenCalledTimes(2); // preparation/key read, then one deciding transaction
    const deciding = batch.mock.calls[1]?.[0] ?? [];
    expect(deciding.some((s) => s.sql.includes("INSERT INTO idempotency_records"))).toBe(true);
    expect(deciding.some((s) => s.sql.includes("INSERT INTO messages"))).toBe(true);
    expect(deciding.some((s) => s.sql.includes("INSERT INTO dispatch_intents"))).toBe(true);
    expect(deciding.every((s) => s.params.length <= 100)).toBe(true);
    expect(await send()).toEqual(result);
    expect(await env.count("messages")).toBe(1);
    expect(await env.count("runs")).toBe(1);
    const record = await env.db.first(sql("SELECT * FROM idempotency_records"));
    expect(record).toMatchObject({ status: "completed", http_status: 202 });
    expect(record?.response_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(record)).not.toContain(input.text);
  });
  it("five racing retries create one message, run and intent", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => send()));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    expect(await env.count("messages")).toBe(1);
    expect(await env.count("runs")).toBe(1);
    expect(await env.count("dispatch_intents")).toBe(1);
    expect(await env.count("idempotency_records")).toBe(1);
  });
  it("records the queued response and replays it even after the queue advances", async () => {
    const first = await send();
    const queued = await send("second-message");
    expect(queued).toMatchObject({ runId: null, status: "queued" });
    await repository.stop(owner, first.runId ?? "");
    expect(
      (await repository.history(owner, conversation)).find((m) => m.id === queued.messageId)
        ?.status,
    ).toBe("accepted");
    expect(await send("second-message")).toEqual(queued);
    expect(await env.count("runs")).toBe(2);
  });
  it("rejects mismatch without changing the original result", async () => {
    const first = await send();
    await expect(send("first-message", { ...input, text: "different" })).rejects.toMatchObject({
      code: "idempotency.mismatch",
    });
    expect(await send()).toEqual(first);
    expect(await env.count("messages")).toBe(1);
  });
  it("does not duplicate a persisted message after the 24-hour response record expires", async () => {
    const first = await send();
    env.clock += 86_400_001;
    expect(await send()).toEqual(first);
    expect(await env.count("messages")).toBe(1);
    expect(await env.count("dispatch_intents")).toBe(1);
    expect((await env.db.first(sql("SELECT status FROM idempotency_records")))?.status).toBe(
      "completed",
    );
  });
  it.each(["relock", "archive", "key_shred"])(
    "does not record success when %s wins before the deciding batch",
    async (change) => {
      const load = repository.loadConversation.bind(repository);
      vi.spyOn(repository, "loadConversation").mockImplementationOnce(async (...args) => {
        const loaded = await load(...args);
        if (change === "relock") await env.relock(owner);
        if (change === "archive") await env.archiveTask(task);
        if (change === "key_shred")
          await env.db.run(sql("DELETE FROM account_keys WHERE owner_id = :owner", { owner }));
        return loaded;
      });
      await expect(send()).rejects.toMatchObject({ code: "simon.stale" });
      expect(await env.count("idempotency_records")).toBe(0);
      expect(await env.count("messages")).toBe(0);
      expect(await env.count("runs")).toBe(0);
    },
  );
  it("does not replay protected responses after a racing relock", async () => {
    await send();
    const load = repository.loadConversation.bind(repository);
    vi.spyOn(repository, "loadConversation").mockImplementationOnce(async (...args) => {
      const loaded = await load(...args);
      await env.relock(owner);
      return loaded;
    });
    await expect(send()).rejects.toMatchObject({ code: "simon.stale" });
  });
  it("releases refused queue claims, so a later retry can run", async () => {
    const first = await send();
    for (let n = 0; n < 20; n++) await send(`queue-${n}`);
    await expect(send("overflow")).rejects.toMatchObject({ code: "simon.stale" });
    expect(await env.count("idempotency_records")).toBe(21);
    await repository.stop(owner, first.runId ?? "");
    expect(await send("overflow")).toMatchObject({ status: "queued" });
    expect(await env.count("idempotency_records")).toBe(22);
  });
  it("rolls the entire transaction back when recording the response fails", async () => {
    const original = fold("broken");
    await expect(
      repository.acceptMessage(owner, conversation, "broken", input, {
        ...original,
        completion: () => sql("UPDATE table_that_does_not_exist SET value = 1 WHERE 1 = 1"),
      }),
    ).rejects.toThrow();
    expect(await env.count("messages")).toBe(0);
    expect(await env.count("runs")).toBe(0);
    expect(await env.count("dispatch_intents")).toBe(0);
    expect(await env.count("idempotency_records")).toBe(0);
  });
  it("rejects a fold belonging to another owner before writing anything", async () => {
    const stranger = await env.createUser();
    await expect(
      repository.acceptMessage(
        owner,
        conversation,
        "foreign",
        input,
        fold("foreign", input, "messages", stranger),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("idempotency_records")).toBe(0);
  });
  it("creates exactly one quick conversation across racing retries", async () => {
    const create = () =>
      repository.createConversation(owner, null, fold("quick", { kind: "quick" }, "conversations"));
    const results = await Promise.all(Array.from({ length: 5 }, create));
    expect(new Set(results).size).toBe(1);
    expect(await env.count("conversations")).toBe(2); // the fixture's task conversation + quick
    expect(await create()).toBe(results[0]);
    expect(
      await env.db.first(sql("SELECT status, http_status FROM idempotency_records")),
    ).toMatchObject({ status: "completed", http_status: 201 });
  });
  it("reuses the task conversation without creating another or disclosing a foreign task", async () => {
    expect(
      await repository.createConversation(owner, task, fold("task", { task }, "conversations")),
    ).toBe(conversation);
    const stranger = await env.createUser();
    const foreignTask = await env.createTask(stranger);
    await expect(
      repository.createConversation(
        owner,
        foreignTask,
        fold("foreign", { foreignTask }, "conversations"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("idempotency_records")).toBe(1);
    expect(await env.count("conversations")).toBe(1);
  });
  it("refuses archived task conversation creation, including an already-existing conversation", async () => {
    await env.archiveTask(task);
    await expect(repository.createConversation(owner, task)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      repository.createConversation(owner, task, fold("archived", { task }, "conversations")),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("idempotency_records")).toBe(0);
  });
  it("cannot reuse a completed conversation claim for another input", async () => {
    await repository.createConversation(
      owner,
      null,
      fold("quick", { kind: "quick" }, "conversations"),
    );
    await expect(
      repository.createConversation(
        owner,
        task,
        fold("quick", { kind: "task", taskId: task }, "conversations"),
      ),
    ).rejects.toMatchObject({ code: "idempotency.mismatch" });
    expect(await env.count("conversations")).toBe(2);
  });
  it("does not disclose an unknown conversation", async () => {
    await expect(
      repository.acceptMessage(owner, uuidv7(), "unknown", input, fold("unknown")),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.count("idempotency_records")).toBe(0);
  });
});
