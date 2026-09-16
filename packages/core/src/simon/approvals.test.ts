import { zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConfirmedConnection, confirmedConnection } from "../connections/authority.ts";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { type ApprovalProposal, SimonApprovals } from "./approvals.ts";
import { SimonInvocations } from "./invocations.ts";
import { SimonPauseReconciler } from "./maintenance.ts";
import { SimonRepository } from "./repository.ts";
import type { ClaimedSimonRun } from "./types.ts";
import { SimonUserAsks } from "./user-asks.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
let approvals: SimonApprovals;
let asks: SimonUserAsks;
let owner: string;
let task: string;
let conversation: string;
let claimed: ClaimedSimonRun;
let connection: ConfirmedConnection;
let proposal: ApprovalProposal;

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  approvals = new SimonApprovals(repository);
  asks = new SimonUserAsks(repository);
  await env.db.run(sql("UPDATE executor_state SET mode = 'local' WHERE id = 1"));
  owner = await env.createUser();
  task = await env.createTask(owner);
  conversation = await repository.createConversation(owner, task);
  const accepted = await repository.acceptMessage(owner, conversation, "send", {
    text: "Send the outline",
    tier: "smart",
  });
  const run = await repository.claim(accepted.runId ?? "", "local");
  if (!run) throw new Error("test expected claim");
  claimed = run;
  const connectionId = uuidv7();
  await env.db.run(
    sql(
      `INSERT INTO connections (id, owner_id, toolkit, connected_account_id, status, confirmed_at, created_at, updated_at, write_id)
    VALUES (:id, :owner, 'gmail', 'ca_test123', 'active', :now, :now, :now, :id)`,
      { id: connectionId, owner, now: int(env.clock) },
    ),
  );
  const confirmed = await confirmedConnection(env.db, owner, connectionId);
  if (!confirmed) throw new Error("test expected connection");
  connection = confirmed;
  proposal = {
    toolCallId: "call_send",
    toolSlug: "GMAIL_SEND_EMAIL",
    connection,
    arguments: {
      recipient: "maya@example.test",
      subject: "Secret marker outline",
      body: "private marker body",
    },
    preview: {
      recipient: "maya@example.test",
      subject: "Secret marker outline",
      body: "private marker body",
    },
    policyVersion: "2026-09-16.1",
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (claimed) zeroize(claimed.key.key);
  await env?.close();
});

describe("approved external action ledger", () => {
  async function continueApproval(decision: "approve" | "deny" | "dismiss" = "approve") {
    const id = await pause();
    const approval = await approvals.load(owner, id);
    const next = await approvals.decide(owner, id, { decision, argDigest: approval.argDigest });
    const nextClaim = await repository.claim(next.runId, "local");
    if (!nextClaim) throw new Error("expected continuation claim");
    zeroize(claimed.key.key);
    claimed = nextClaim;
    return id;
  }

  it.each([false, true])(
    "dual-reads a legacy generation without accepting a reconnect (%s)",
    async (reconnected) => {
      const id = await continueApproval();
      await env.db.run(
        sql("UPDATE approvals SET connection_generation = NULL WHERE id = :id", { id }),
      );
      expect((await approvals.load(owner, id)).connectionGeneration).toBe(1);
      if (reconnected)
        await env.db.run(
          sql("UPDATE connections SET generation = generation + 1 WHERE id = :id", {
            id: connection.id,
          }),
        );
      const send = vi.fn(async () => ({ status: "succeeded" as const, result: { sent: true } }));
      expect(
        await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
      ).toEqual(
        reconnected ? { status: "expired" } : { status: "succeeded", result: { sent: true } },
      );
      expect(send).toHaveBeenCalledTimes(reconnected ? 0 : 1);
    },
  );

  it("sends exactly the stored arguments once, and encrypts its durable result", async () => {
    const id = await continueApproval();
    const ledger = new SimonInvocations(repository);
    const send = vi.fn(async () => ({
      status: "succeeded" as const,
      result: { sent: true, message: "private response marker" },
    }));
    const outcome = await ledger.executeApproved(claimed.run, claimed.key, id, send);
    expect(outcome).toEqual({
      status: "succeeded",
      result: { sent: true, message: "private response marker" },
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      toolSlug: proposal.toolSlug,
      arguments: proposal.arguments,
      connection,
      idempotencyKey: id,
    });
    expect(await ledger.executeApproved(claimed.run, claimed.key, id, send)).toEqual(outcome);
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await env.db.all(sql("SELECT * FROM tool_invocations"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", approval_id: id, idempotency_key: id });
    expect(rows[0]?.result_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(rows)).not.toContain("marker");
  });
  it("records a provider timeout as uncertain and never retries it", async () => {
    const id = await continueApproval();
    const ledger = new SimonInvocations(repository);
    const send = vi.fn(async () => {
      throw new Error("timeout: private request and result marker");
    });
    expect(await ledger.executeApproved(claimed.run, claimed.key, id, send)).toEqual({
      status: "uncertain",
    });
    expect(await ledger.executeApproved(claimed.run, claimed.key, id, send)).toEqual({
      status: "uncertain",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.db.first(sql("SELECT status, result_enc FROM tool_invocations"))).toEqual({
      status: "uncertain",
      result_enc: null,
    });
  });
  it("does not retry a confirmed provider failure", async () => {
    const id = await continueApproval();
    const ledger = new SimonInvocations(repository);
    const send = vi.fn(async () => ({
      status: "failed" as const,
      result: { code: "integration.refused" },
    }));
    expect(await ledger.executeApproved(claimed.run, claimed.key, id, send)).toEqual({
      status: "failed",
      result: { code: "integration.refused" },
    });
    await ledger.executeApproved(claimed.run, claimed.key, id, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("cannot steal an invocation while its original side effect is still running", async () => {
    const id = await continueApproval();
    const ledger = new SimonInvocations(repository);
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const send = vi.fn(async () => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "succeeded" as const, result: { sent: true } };
    });
    const first = ledger.executeApproved(claimed.run, claimed.key, id, send);
    await started;
    expect(await ledger.executeApproved(claimed.run, claimed.key, id, send)).toEqual({
      status: "uncertain",
    });
    release?.();
    expect(await first).toEqual({ status: "succeeded", result: { sent: true } });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("survives a crash after the external effect but before its result was saved", async () => {
    const id = await continueApproval();
    const batch = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (statements.some((statement) => statement.sql.includes("UPDATE tool_invocations")))
        throw new Error("crashed before checkpoint");
      return batch(statements, options);
    });
    const send = vi.fn(async () => ({ status: "succeeded" as const, result: { sent: true } }));
    expect(
      await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
    ).toEqual({ status: "uncertain" });
    vi.restoreAllMocks();
    expect(
      await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
    ).toEqual({ status: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await env.db.first(sql("SELECT status FROM tool_invocations")))?.status).toBe(
      "started",
    );
  });
  it("never sends after an unknown claim outcome even when the insert committed", async () => {
    const id = await continueApproval();
    const batch = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      const result = await batch(statements, options);
      if (statements.some((statement) => statement.sql.includes("INSERT INTO tool_invocations")))
        throw new Error("claim_outcome_unknown");
      return result;
    });
    const send = vi.fn(async () => ({ status: "succeeded" as const, result: {} }));
    await expect(
      new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
    ).rejects.toThrow("claim_outcome_unknown");
    vi.restoreAllMocks();
    expect(
      await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
    ).toEqual({ status: "uncertain" });
    expect(send).not.toHaveBeenCalled();
  });
  it("returns a saved result after its approval has subsequently expired", async () => {
    const id = await continueApproval();
    const ledger = new SimonInvocations(repository);
    const send = vi.fn(async () => ({ status: "succeeded" as const, result: { sent: true } }));
    await ledger.executeApproved(claimed.run, claimed.key, id, send);
    env.clock += 86_400_000;
    expect(await ledger.executeApproved(claimed.run, claimed.key, id, send)).toEqual({
      status: "succeeded",
      result: { sent: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["deny", "dismiss"] as const)(
    "reports %s to the model without executing",
    async (decision) => {
      const id = await continueApproval(decision);
      const send = vi.fn(async () => ({ status: "succeeded" as const, result: {} }));
      expect(
        await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
      ).toEqual({ status: decision === "deny" ? "denied" : "dismissed" });
      expect(send).not.toHaveBeenCalled();
      expect(await env.count("tool_invocations")).toBe(0);
    },
  );
  it.each(["expiry", "reconnect", "disconnect", "changed_account"])(
    "does not send after %s",
    async (change) => {
      const id = await continueApproval();
      if (change === "expiry") env.clock += 86_400_000;
      if (change === "reconnect")
        await env.db.run(sql("UPDATE connections SET generation = generation + 1"));
      if (change === "disconnect")
        await env.db.run(sql("UPDATE connections SET status = 'disconnected'"));
      if (change === "changed_account")
        await env.db.run(sql("UPDATE connections SET connected_account_id = 'ca_changed'"));
      const send = vi.fn(async () => ({ status: "succeeded" as const, result: {} }));
      expect(
        await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
      ).toEqual({ status: "expired" });
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("revalidates connection generation in the ledger's deciding insert", async () => {
    const id = await continueApproval();
    const batch = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementation(async (statements, options) => {
      if (statements.some((statement) => statement.sql.includes("INSERT INTO tool_invocations")))
        await batch([sql("UPDATE connections SET generation = generation + 1")]);
      return batch(statements, options);
    });
    const send = vi.fn(async () => ({ status: "succeeded" as const, result: {} }));
    await expect(
      new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
    ).rejects.toMatchObject({ code: "approval.stale" });
    expect(send).not.toHaveBeenCalled();
    expect(await env.count("tool_invocations")).toBe(0);
  });
  it("preserves an already completed effect when Stop is requested during delivery", async () => {
    const id = await continueApproval();
    const send = vi.fn(async () => {
      await repository.stop(owner, claimed.run.id);
      return { status: "succeeded" as const, result: { sent: true } };
    });
    expect(
      await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
    ).toEqual({ status: "succeeded", result: { sent: true } });
    expect((await env.db.first(sql("SELECT status FROM tool_invocations")))?.status).toBe(
      "succeeded",
    );
  });
  it.each(["relock", "archive", "generation"])(
    "fences a result checkpoint after %s during delivery",
    async (change) => {
      const id = await continueApproval();
      const send = vi.fn(async () => {
        if (change === "relock") await env.relock(owner);
        if (change === "archive") await env.archiveTask(task);
        if (change === "generation")
          await env.db.run(sql("UPDATE executor_state SET generation = generation + 1"));
        return { status: "succeeded" as const, result: { sent: true } };
      });
      expect(
        await new SimonInvocations(repository).executeApproved(claimed.run, claimed.key, id, send),
      ).toEqual({ status: "uncertain" });
      expect((await env.db.first(sql("SELECT status FROM tool_invocations")))?.status).toBe(
        "started",
      );
    },
  );
});

const pause = () =>
  approvals.pause(claimed.run, claimed.key, proposal, {
    text: "Please review this draft.",
    steps: 1,
  });
const queued = () =>
  repository.acceptMessage(owner, conversation, "follow-up", {
    text: "A queued follow-up",
    tier: "fast",
  });

describe("approval pause", () => {
  it("atomically checkpoints, encrypts the exact arguments and keeps the conversation active", async () => {
    const id = await pause();
    expect(await approvals.load(owner, id)).toMatchObject({
      status: "pending",
      arguments: proposal.arguments,
      preview: proposal.preview,
      connectionGeneration: 1,
    });
    expect((await repository.run(owner, claimed.run.id))?.status).toBe("awaiting_approval");
    expect(
      (
        await env.db.first(
          sql("SELECT active_run_id FROM conversations WHERE id = :id", { id: conversation }),
        )
      )?.active_run_id,
    ).toBe(claimed.run.id);
    expect((await repository.history(owner, conversation)).at(-1)?.text).toBe(
      "Please review this draft.",
    );
    const raw = await env.db.all(sql("SELECT * FROM approvals"));
    expect(raw[0]?.arguments_enc).toMatch(/^sym1\./);
    expect(raw[0]?.preview_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(raw)).not.toContain("marker");
    expect(await env.count("dispatch_intents")).toBe(1);
  });
  it("never interprets a queued yes as approval", async () => {
    const id = await pause();
    const reply = await repository.acceptMessage(owner, conversation, "yes", {
      text: "yes, send it",
      tier: "fast",
    });
    expect(reply.status).toBe("queued");
    expect((await approvals.load(owner, id)).status).toBe("pending");
    expect(await env.count("runs")).toBe(1);
    expect(await env.count("tool_invocations")).toBe(0);
  });
  it("rejects a second pause and does not create a second approval", async () => {
    await pause();
    await expect(pause()).rejects.toMatchObject({ code: "simon.stale" });
    expect(await env.count("approvals")).toBe(1);
  });
  it.each(["disconnect", "reconnect", "owner", "account", "archive", "relock", "generation"])(
    "refuses a stale proposal after %s",
    async (change) => {
      if (change === "disconnect")
        await env.db.run(sql("UPDATE connections SET status = 'disconnected'"));
      if (change === "reconnect")
        await env.db.run(sql("UPDATE connections SET generation = generation + 1"));
      if (change === "owner")
        await env.db.run(
          sql("UPDATE connections SET owner_id = :owner", { owner: await env.createUser() }),
        );
      if (change === "account")
        await env.db.run(sql("UPDATE connections SET connected_account_id = 'ca_replaced'"));
      if (change === "archive") await env.archiveTask(task);
      if (change === "relock") await env.relock(owner);
      if (change === "generation")
        await env.db.run(sql("UPDATE executor_state SET generation = generation + 1"));
      await expect(pause()).rejects.toMatchObject({ code: "simon.stale" });
      expect(await env.count("approvals")).toBe(0);
    },
  );
  it("refuses another owner's confirmed connection", async () => {
    await expect(
      approvals.pause(
        claimed.run,
        claimed.key,
        { ...proposal, connection: { ...connection, ownerId: await env.createUser() } },
        { text: "", steps: 1 },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("single-winner approval decisions", () => {
  it.each(["approve", "deny", "dismiss"] as const)(
    "%s dispatches a continuation before queued follow-ups",
    async (decision) => {
      const id = await pause();
      const followUp = await queued();
      const view = await approvals.load(owner, id);
      const result = await approvals.decide(owner, id, { decision, argDigest: view.argDigest });
      expect((await repository.run(owner, claimed.run.id))?.status).toBe("completed");
      expect(await repository.run(owner, result.runId)).toMatchObject({
        kind: "continuation",
        approvalId: id,
        tier: "smart",
        status: "queued",
      });
      expect(
        (await repository.history(owner, conversation)).find(
          (message) => message.id === followUp.messageId,
        )?.status,
      ).toBe("queued");
      expect(await env.count("dispatch_intents")).toBe(2);
      expect(await env.count("tool_invocations")).toBe(0);
      expect(
        (
          await env.db.first(
            sql("SELECT active_run_id FROM conversations WHERE id = :id", { id: conversation }),
          )
        )?.active_run_id,
      ).toBe(result.runId);
    },
  );
  it("allows exactly one of simultaneous opposing decisions", async () => {
    const id = await pause();
    const view = await approvals.load(owner, id);
    const results = await Promise.allSettled(
      ["approve", "deny", "dismiss"].map((decision) =>
        approvals.decide(owner, id, {
          decision: decision as "approve" | "deny" | "dismiss",
          argDigest: view.argDigest,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(await env.count("runs")).toBe(2);
    expect(await env.count("dispatch_intents")).toBe(2);
  });
  it("binds the decision to the exact digest and owner", async () => {
    const id = await pause();
    const view = await approvals.load(owner, id);
    await expect(
      approvals.decide(owner, id, { decision: "approve", argDigest: "A".repeat(43) }),
    ).rejects.toMatchObject({ code: "approval.stale" });
    await expect(
      approvals.decide(await env.createUser(), id, {
        decision: "approve",
        argDigest: view.argDigest,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await approvals.load(owner, id)).status).toBe("pending");
  });
  it.each(["archive", "relock", "stop", "expiry"])("cannot decide after %s", async (change) => {
    const id = await pause();
    const view = await approvals.load(owner, id);
    if (change === "archive") await env.archiveTask(task);
    if (change === "relock") await env.relock(owner);
    if (change === "stop") await repository.stop(owner, claimed.run.id);
    if (change === "expiry") env.clock += 86_400_000;
    await expect(
      approvals.decide(owner, id, { decision: "approve", argDigest: view.argDigest }),
    ).rejects.toThrow();
    expect(await env.count("runs")).toBe(1);
  });
  it("checks task state again after the preliminary read", async () => {
    const id = await pause();
    const view = await approvals.load(owner, id);
    const batch = env.db.batch.bind(env.db);
    vi.spyOn(env.db, "batch").mockImplementationOnce(async (...args) => {
      const result = await batch(...args);
      await env.archiveTask(task);
      return result;
    });
    await expect(
      approvals.decide(owner, id, { decision: "approve", argDigest: view.argDigest }),
    ).rejects.toMatchObject({ code: "approval.stale" });
    expect(
      (await env.db.first(sql("SELECT status FROM approvals WHERE id = :id", { id })))?.status,
    ).toBe("pending");
  });
  it("moves a continuation to the current executor after a mode switch", async () => {
    const id = await pause();
    const view = await approvals.load(owner, id);
    await env.db.run(
      sql("UPDATE executor_state SET mode = 'durable', generation = generation + 1"),
    );
    const decision = await approvals.decide(owner, id, {
      decision: "deny",
      argDigest: view.argDigest,
    });
    expect(await repository.run(owner, decision.runId)).toMatchObject({
      executor: "trigger",
      generation: 2,
    });
    expect(await repository.claim(decision.runId, "local")).toBeNull();
  });
});

describe("edited drafts and expiry", () => {
  it("does not let expired ineligible pauses monopolize the sweep", async () => {
    await pause();
    env.clock += 86_400_000;
    await env.archiveTask(task);
    expect(
      await new SimonPauseReconciler(repository).run({ executor: "local", generation: 1 }),
    ).toEqual({ consideredCount: 0 });
    expect(await env.count("runs")).toBe(1);
  });

  it("binds an expiry to the run that actually owns its pause", async () => {
    const id = await pause();
    env.clock += 86_400_000;
    await env.db.batch(
      approvals.expireStatements({
        ownerId: owner,
        approvalId: id,
        runId: uuidv7(),
        now: env.clock,
        cause: "time",
      }),
    );
    expect((await approvals.load(owner, id)).status).toBe("pending");
    expect(await env.count("runs")).toBe(1);
  });
  it("runs the bounded sweep only in its current executor generation", async () => {
    const id = await pause();
    env.clock += 86_400_000;
    const sweep = new SimonPauseReconciler(repository);
    expect(await sweep.run({ executor: "trigger", generation: 1 })).toEqual({ consideredCount: 0 });
    expect(await sweep.run({ executor: "local", generation: 2 })).toEqual({ consideredCount: 0 });
    expect((await approvals.load(owner, id)).status).toBe("pending");
    expect(await sweep.run({ executor: "local", generation: 1 })).toEqual({ consideredCount: 1 });
    expect((await approvals.load(owner, id)).status).toBe("expired");
    expect(await sweep.run({ executor: "local", generation: 1 })).toEqual({ consideredCount: 0 });
    expect(await env.count("runs")).toBe(2);
  });

  it("fences expiry when the executor switches after the sweep's read", async () => {
    const id = await pause();
    env.clock += 86_400_000;
    const read = env.db.all.bind(env.db);
    vi.spyOn(env.db, "all").mockImplementation(async (...args) => {
      const result = await read(...args);
      await env.db.run(sql("UPDATE executor_state SET generation = generation + 1"));
      return result;
    });
    await new SimonPauseReconciler(repository).run({ executor: "local", generation: 1 });
    expect((await approvals.load(owner, id)).status).toBe("pending");
    expect(await env.count("runs")).toBe(1);
  });
  it("supersedes an edit without executing or dispatching until a fresh approval", async () => {
    const id = await pause();
    const original = await approvals.load(owner, id);
    const args = { recipient: "other@example.test", body: "changed draft" };
    const replacement = await approvals.decide(
      owner,
      id,
      { decision: "approve", argDigest: original.argDigest, editedArguments: args },
      async (input) => ({
        arguments: input.editedArguments,
        preview: input.editedArguments,
        policyVersion: "new-policy",
      }),
    );
    expect(replacement.status).toBe("pending");
    expect(replacement.runId).toBe(claimed.run.id);
    expect(replacement.approvalId).not.toBe(id);
    const edited = await approvals.load(owner, replacement.approvalId);
    expect(edited.arguments).toEqual(args);
    expect(edited.argDigest).not.toBe(original.argDigest);
    expect((await approvals.load(owner, id)).status).toBe("superseded");
    expect(await env.count("dispatch_intents")).toBe(1);
    await expect(
      approvals.decide(owner, replacement.approvalId, {
        decision: "approve",
        argDigest: original.argDigest,
      }),
    ).rejects.toMatchObject({ code: "approval.stale" });
    await approvals.decide(owner, replacement.approvalId, {
      decision: "approve",
      argDigest: edited.argDigest,
    });
    expect(await env.count("dispatch_intents")).toBe(2);
  });
  it("cannot bypass schema validation with edited arguments", async () => {
    const id = await pause();
    const original = await approvals.load(owner, id);
    await expect(
      approvals.decide(owner, id, {
        decision: "approve",
        argDigest: original.argDigest,
        editedArguments: {},
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      approvals.decide(
        owner,
        id,
        { decision: "approve", argDigest: original.argDigest, editedArguments: {} },
        async () => {
          throw new Error("validation");
        },
      ),
    ).rejects.toThrow("validation");
    expect((await approvals.load(owner, id)).status).toBe("pending");
  });
  it("connection replacement during validation invalidates the edit", async () => {
    const id = await pause();
    const original = await approvals.load(owner, id);
    await expect(
      approvals.decide(
        owner,
        id,
        { decision: "approve", argDigest: original.argDigest, editedArguments: {} },
        async () => {
          await env.db.run(sql("UPDATE connections SET generation = generation + 1"));
          return { arguments: {}, preview: {}, policyVersion: "test" };
        },
      ),
    ).rejects.toMatchObject({ code: "approval.stale" });
  });
  it("expires once at the boundary, preserving an expired result for the model", async () => {
    const id = await pause();
    const expire = () =>
      approvals.expireStatements({
        ownerId: owner,
        approvalId: id,
        runId: claimed.run.id,
        now: env.clock,
        cause: "time",
      });
    await env.db.batch(expire());
    expect((await approvals.load(owner, id)).status).toBe("pending");
    env.clock += 86_400_000;
    await env.db.batch(expire());
    await env.db.batch(expire());
    expect((await approvals.load(owner, id)).status).toBe("expired");
    expect(await env.count("runs")).toBe(2);
    expect(await env.count("dispatch_intents")).toBe(2);
  });
  it("connection expiry participates in its caller's exact deciding batch", async () => {
    const id = await pause();
    const writeId = uuidv7();
    const expire = () =>
      approvals.expireStatements({
        ownerId: owner,
        approvalId: id,
        runId: claimed.run.id,
        now: env.clock,
        cause: "connection",
        guard: {
          sql: "EXISTS (SELECT 1 FROM connections WHERE id = :connection AND write_id = :connection_w)",
          params: { connection: connection.id, connection_w: writeId },
        },
      });
    await env.db.batch(expire());
    expect((await approvals.load(owner, id)).status).toBe("pending");
    await env.db.batch([
      sql(
        "UPDATE connections SET status = 'needs_attention', generation = generation + 1, write_id = :w WHERE id = :id",
        { id: connection.id, w: writeId },
      ),
      ...expire(),
    ]);
    expect((await approvals.load(owner, id)).status).toBe("expired");
    expect(await env.count("runs")).toBe(2);
  });
});

describe("persisted user questions", () => {
  const ask = () =>
    asks.pause(
      claimed.run,
      claimed.key,
      { toolCallId: "call_ask", question: "Which account?" },
      { text: "One detail needed.", steps: 1 },
    );
  it("only the answer endpoint consumes a question; regular chat remains queued", async () => {
    const id = await ask();
    await queued();
    expect((await asks.load(owner, id)).status).toBe("pending");
    const next = await asks.decide(owner, id, { kind: "answer", text: "Use the personal account" });
    expect(await asks.load(owner, id)).toMatchObject({
      status: "answered",
      answer: "Use the personal account",
    });
    expect(await repository.run(owner, next)).toMatchObject({ kind: "continuation", askId: id });
    expect(
      (await repository.history(owner, conversation)).find((m) => m.text === "A queued follow-up")
        ?.status,
    ).toBe("queued");
    expect(JSON.stringify(await env.db.all(sql("SELECT * FROM user_asks")))).not.toContain(
      "personal account",
    );
  });
  it("allows only one answer or dismissal even with different request ids", async () => {
    const id = await ask();
    const results = await Promise.allSettled([
      asks.decide(owner, id, { kind: "answer", text: "Personal" }),
      asks.decide(owner, id, { kind: "dismiss" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await env.count("runs")).toBe(2);
  });
  it("dismisses without inventing an answer", async () => {
    const id = await ask();
    await asks.decide(owner, id, { kind: "dismiss" });
    expect(await asks.load(owner, id)).toMatchObject({ status: "dismissed", answer: null });
  });
  it("rejects foreign answers and expires without repeating continuations", async () => {
    const id = await ask();
    await expect(
      asks.decide(await env.createUser(), id, { kind: "answer", text: "wrong user" }),
    ).rejects.toMatchObject({ code: "not_found" });
    env.clock += 86_400_000;
    await expect(
      asks.decide(owner, id, { kind: "answer", text: "too late" }),
    ).rejects.toMatchObject({ code: "user_ask.stale" });
    const input = { ownerId: owner, askId: id, runId: claimed.run.id, now: env.clock };
    await env.db.batch(asks.expireStatements(input));
    await env.db.batch(asks.expireStatements(input));
    expect((await asks.load(owner, id)).status).toBe("expired");
    expect(await env.count("runs")).toBe(2);
  });
});
