import { zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmedConnection } from "../connections/authority.ts";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonApprovals } from "./approvals.ts";
import { SimonInvocations } from "./invocations.ts";
import { SimonExecutionTracker } from "./lifecycle.ts";
import { SimonRepository } from "./repository.ts";
import { SimonRetries } from "./retries.ts";
import type { ClaimedSimonRun } from "./types.ts";
import { SimonUserAsks } from "./user-asks.ts";

let env: DocumentsTestEnvironment;
let repo: SimonRepository;
let retries: SimonRetries;
let owner: string;
let task: string;
let conversation: string;
const claims: ClaimedSimonRun[] = [];
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  repo = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  retries = new SimonRetries(repo);
  await env.db.run(sql("UPDATE executor_state SET mode = 'local' WHERE id = 1"));
  owner = await env.createUser();
  task = await env.createTask(owner);
  conversation = await repo.createConversation(owner, task);
});
afterEach(async () => {
  for (const claim of claims.splice(0)) zeroize(claim.key.key);
  vi.restoreAllMocks();
  await env?.close();
});
async function claim(runId: string) {
  const owned = await repo.claim(runId, "local");
  if (!owned) throw new Error("Expected claim");
  claims.push(owned);
  return owned;
}
async function start() {
  const sent = await repo.acceptMessage(owner, conversation, uuidv7(), {
    text: "hello",
    tier: "smart",
  });
  return claim(sent.runId ?? "");
}
async function interrupt(runId: string) {
  expect(
    await new SimonExecutionTracker(env.db).markInterrupted(runId, {
      outcomeCode: "executor_lost",
      now: env.clock,
    }),
  ).toBe(true);
}
const snapshot = (runId: string, text: string) =>
  JSON.stringify({ id: runId, role: "assistant", parts: [{ type: "text", text }] });

describe("explicit Simon retries", () => {
  it.each(["interrupted", "failed", "stopped"] as const)(
    "continues %s history with a new run and current executor generation",
    async (status) => {
      const active = await start();
      if (status === "stopped") await repo.stop(owner, active.run.id);
      expect(await repo.checkpoint(active.run, active.key, "keep partial", 1, status)).toBe(true);
      await env.db.run(
        sql("UPDATE executor_state SET generation = generation + 1, mode = 'durable'"),
      );
      const next = await retries.create(owner, active.run.id);
      expect(next.runId).not.toBe(active.run.id);
      expect(await repo.run(owner, next.runId)).toMatchObject({
        kind: "retry",
        executor: "trigger",
        generation: 2,
        tier: "smart",
        status: "queued",
      });
      expect((await repo.history(owner, conversation)).at(-1)?.text).toBe("keep partial");
      expect(await env.count("messages")).toBe(2);
      expect(await env.count("runs")).toBe(2);
      expect(await env.count("dispatch_intents")).toBe(2);
    },
  );
  it("only one racing retry claims the conversation and the predecessor cannot be retried again", async () => {
    const active = await start();
    await interrupt(active.run.id);
    const results = await Promise.allSettled([
      retries.create(owner, active.run.id),
      retries.create(owner, active.run.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const next = results.find((r) => r.status === "fulfilled");
    if (next?.status !== "fulfilled") throw new Error("Expected retry");
    await repo.stop(owner, next.value.runId);
    await expect(retries.create(owner, active.run.id)).rejects.toMatchObject({
      code: "simon.stale",
    });
    expect((await retries.create(owner, next.value.runId)).runId).not.toBe(next.value.runId);
  });
  it("cannot displace an active run, completed run, or queued follow-up", async () => {
    const active = await start();
    await expect(retries.create(owner, active.run.id)).rejects.toMatchObject({
      code: "simon.stale",
    });
    await repo.checkpoint(active.run, active.key, "done", 1, "completed");
    await expect(retries.create(owner, active.run.id)).rejects.toMatchObject({
      code: "simon.stale",
    });
    const second = await start();
    await repo.acceptMessage(owner, conversation, "queued", { text: "another", tier: "fast" });
    await interrupt(second.run.id);
    await expect(retries.create(owner, second.run.id)).rejects.toMatchObject({
      code: "simon.stale",
    });
    expect(await env.count("runs")).toBe(3);
  });
  it.each(["foreign", "archived", "relocked", "expired"])("refuses %s retries", async (state) => {
    if (state === "expired") conversation = await repo.createConversation(owner, null);
    const active = await start();
    await interrupt(active.run.id);
    if (state === "archived") await env.archiveTask(task);
    if (state === "relocked") await env.relock(owner);
    if (state === "expired") env.clock += 86_400_000;
    await expect(
      retries.create(state === "foreign" ? await env.createUser() : owner, active.run.id),
    ).rejects.toMatchObject({ code: state === "archived" ? "simon.stale" : "not_found" });
    expect(await env.count("runs")).toBe(1);
  });
  it("resolves a question's snapshot after multiple interrupted continuations", async () => {
    const active = await start();
    const asks = new SimonUserAsks(repo);
    const ask = await asks.pause(
      active.run,
      active.key,
      { question: "Which?", toolCallId: "ask_1" },
      { text: "Which?", steps: 1, snapshotJson: snapshot(active.run.id, "Which?") },
    );
    const continued = await asks.decide(owner, ask, { kind: "answer", text: "First" });
    await claim(continued);
    await interrupt(continued);
    const firstRetry = await retries.create(owner, continued);
    await claim(firstRetry.runId);
    await interrupt(firstRetry.runId);
    const next = await retries.create(owner, firstRetry.runId);
    const owned = await claim(next.runId);
    expect(owned.run.askId).toBe(ask);
    expect(
      await repo.resolvePauseSnapshot(
        owned.run,
        owned.key,
        active.run.id,
        snapshot(active.run.id, "Resolved: First"),
      ),
    ).toBe(true);
    expect(
      (await repo.executionHistory(owned.run, owned.key)).some((row) =>
        row.snapshotJson?.includes("Resolved: First"),
      ),
    ).toBe(true);
    expect(
      await repo.resolvePauseSnapshot(
        owned.run,
        owned.key,
        firstRetry.runId,
        snapshot(firstRetry.runId, "wrong"),
      ),
    ).toBe(false);
  });
  it("carries the newly expired question when retrying a stopped paused run", async () => {
    const active = await start();
    const ask = await new SimonUserAsks(repo).pause(
      active.run,
      active.key,
      { question: "Which?", toolCallId: "ask_1" },
      { text: "Which?", steps: 1 },
    );
    await repo.stop(owner, active.run.id);
    const next = await retries.create(owner, active.run.id);
    expect(await repo.run(owner, next.runId)).toMatchObject({ askId: ask });
    expect((await new SimonUserAsks(repo).load(owner, ask)).status).toBe("expired");
  });
  it.each(["succeeded", "uncertain"] as const)(
    "reads a %s action ledger on retry without resending",
    async (outcome) => {
      const active = await start();
      const connectionId = uuidv7();
      await env.db.run(
        sql(
          `INSERT INTO connections (id, owner_id, toolkit, connected_account_id, status, confirmed_at, created_at, updated_at, write_id)
      VALUES (:id, :owner, 'gmail', 'ca_retry', 'active', :now, :now, :now, :id)`,
          { id: connectionId, owner, now: int(env.clock) },
        ),
      );
      const connection = await confirmedConnection(env.db, owner, connectionId);
      if (!connection) throw new Error("Expected connection");
      const approvals = new SimonApprovals(repo);
      const approvalId = await approvals.pause(
        active.run,
        active.key,
        {
          toolCallId: "send_1",
          toolSlug: "GMAIL_SEND_EMAIL",
          connection,
          arguments: { to: "maya@example.test", body: "hello" },
          preview: { body: "hello" },
          policyVersion: "test",
        },
        { text: "Review", steps: 1 },
      );
      const approval = await approvals.load(owner, approvalId);
      const continuation = await approvals.decide(owner, approvalId, {
        decision: "approve",
        argDigest: approval.argDigest,
      });
      const first = await claim(continuation.runId);
      const effect = vi.fn(async () => {
        if (outcome === "uncertain") throw new Error("network lost after send");
        return { status: "succeeded" as const, result: { sent: true } };
      });
      const invocations = new SimonInvocations(repo);
      expect(
        await invocations.executeApproved(first.run, first.key, approvalId, effect),
      ).toMatchObject({ status: outcome });
      await interrupt(first.run.id);
      const next = await retries.create(owner, first.run.id);
      const second = await claim(next.runId);
      expect(second.run.approvalId).toBe(approvalId);
      expect(
        await invocations.executeApproved(second.run, second.key, approvalId, effect),
      ).toMatchObject({ status: outcome });
      expect(effect).toHaveBeenCalledTimes(1);
      expect(await env.count("tool_invocations")).toBe(1);
    },
  );
});
