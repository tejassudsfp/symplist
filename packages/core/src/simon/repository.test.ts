import { decryptFieldText, zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simonRestrictContributor } from "../access/restrict-contributors/simon.ts";
import { simonPurgeContributor } from "../account/purge-contributors/simon.ts";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { simonArchiveContributor } from "../tasks/archive-contributors/simon.ts";
import { SimonExecutionTracker, SimonRunRelaySource } from "./lifecycle.ts";
import { SimonRepository, simonField } from "./repository.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
let owner: string;
let task: string;
let conversation: string;

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
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
afterEach(async () => env?.close());

const send = (request = "one", text = "private marker text") =>
  repository.acceptMessage(owner, conversation, request, { text, tier: "fast" });
const claim = async () => {
  const accepted = await send();
  const claimed = await repository.claim(accepted.runId ?? "", "local");
  if (!claimed) throw new Error("test expected a claimed run");
  return claimed;
};

describe("conversation creation", () => {
  it("has exactly one conversation for a task", async () => {
    expect(await repository.createConversation(owner, task)).toBe(conversation);
    expect(await env.count("conversations")).toBe(1);
  });
  it("binds foreign keys to both resource and owner", async () => {
    const stranger = await env.createUser();
    await expect(
      env.db.run(
        sql(
          `INSERT INTO conversations (id, owner_id, kind, task_id, created_at, updated_at, write_id)
      VALUES (:id, :owner, 'task', :task, 1, 1, :id)`,
          { id: uuidv7(), owner: stranger, task },
        ),
      ),
    ).rejects.toThrow();
  });
  it("does not disclose foreign tasks or conversations", async () => {
    const stranger = await env.createUser();
    await expect(repository.createConversation(stranger, task)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(repository.loadConversation(stranger, conversation)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(repository.history(stranger, conversation)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("expires task-less quick chats after the configured idle lifetime", async () => {
    const quick = await repository.createConversation(owner, null);
    const row = await env.db.first(
      sql("SELECT * FROM conversations WHERE id = :id", { id: quick }),
    );
    expect(row).toMatchObject({ kind: "quick", task_id: null, expires_at: env.clock + 86_400_000 });
    env.clock += 86_400_000;
    await expect(repository.loadConversation(owner, quick)).rejects.toMatchObject({
      code: "simon.conversation_expired",
    });
  });
  it("extends quick chat lifetime only when a new message is accepted", async () => {
    conversation = await repository.createConversation(owner, null);
    env.clock += 3_600_000;
    await send();
    const expiry = (
      await env.db.first(
        sql("SELECT expires_at FROM conversations WHERE id = :id", { id: conversation }),
      )
    )?.expires_at;
    expect(expiry).toBe(env.clock + 86_400_000);
    env.clock += 3_600_000;
    await send();
    expect(
      (
        await env.db.first(
          sql("SELECT expires_at FROM conversations WHERE id = :id", { id: conversation }),
        )
      )?.expires_at,
    ).toBe(expiry);
  });
});

describe("message acceptance", () => {
  it("persists encrypted messages, a run, a claim and an intent atomically", async () => {
    const accepted = await send();
    expect(accepted.status).toBe("accepted");
    const rows = await env.db.all(sql("SELECT * FROM messages"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(rows)).not.toContain("private marker text");
    expect(await repository.history(owner, conversation)).toMatchObject([
      { text: "private marker text", role: "user", seq: 1 },
    ]);
    expect(await env.count("runs")).toBe(1);
    expect(await env.count("dispatch_intents")).toBe(1);
    expect(
      (
        await env.db.first(
          sql("SELECT active_run_id FROM conversations WHERE id = :id", { id: conversation }),
        )
      )?.active_run_id,
    ).toBe(accepted.runId);
  });
  it("deduplicates simultaneous identical submissions", async () => {
    const responses = await Promise.all([send(), send(), send()]);
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[1]).toEqual(responses[2]);
    expect(await env.count("messages")).toBe(1);
    expect(await env.count("runs")).toBe(1);
  });
  it("rejects a reused key with different text or tier", async () => {
    await send();
    await expect(send("one", "other text")).rejects.toMatchObject({ code: "idempotency.mismatch" });
    await expect(
      repository.acceptMessage(owner, conversation, "one", {
        text: "private marker text",
        tier: "smart",
      }),
    ).rejects.toMatchObject({ code: "idempotency.mismatch" });
    expect(await env.count("messages")).toBe(1);
  });
  it("queues different simultaneous submissions behind exactly one run", async () => {
    const responses = await Promise.all([send("a"), send("b"), send("c")]);
    expect(responses.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(responses.filter((r) => r.status === "queued")).toHaveLength(2);
    expect(await env.count("runs")).toBe(1);
    expect((await repository.history(owner, conversation)).map((message) => message.seq)).toEqual([
      1, 2, 3,
    ]);
  });
  it("refuses writes to an archived task while preserving history", async () => {
    await send();
    await env.archiveTask(task);
    await expect(send("two")).rejects.toMatchObject({ code: "task.archived" });
    expect(await repository.history(owner, conversation)).toHaveLength(1);
  });
  it("rejects access loss even for an exact request replay", async () => {
    await send();
    await env.relock(owner);
    await expect(send()).rejects.toMatchObject({ code: "access.relocked" });
  });
  it("folds fresh access into writes when a relock races the preliminary read", async () => {
    const load = repository.loadConversation.bind(repository);
    repository.loadConversation = async (...args) => {
      const result = await load(...args);
      await env.relock(owner);
      return result;
    };
    await expect(send()).rejects.toMatchObject({ code: "simon.stale" });
    expect(await env.count("messages")).toBe(0);
    expect(await env.count("runs")).toBe(0);
    expect(await env.count("dispatch_intents")).toBe(0);
  });
  it("bounds the queue and still permits an exact retry at capacity", async () => {
    await send();
    for (let i = 0; i < 20; i += 1) await send(`queued-${i}`);
    await expect(send("overflow")).rejects.toMatchObject({ code: "simon.stale" });
    expect((await send()).status).toBe("accepted");
    expect(await env.count("messages")).toBe(21);
  });
  it("binds ciphertext to its owner, row and column", async () => {
    await send();
    const row = await env.db.first(sql("SELECT * FROM messages"));
    const key = await repository.accountKeys.require(owner);
    try {
      expect(() =>
        decryptFieldText(
          key,
          simonField(owner, "messages", uuidv7(), "content_enc"),
          String(row?.content_enc),
        ),
      ).toThrow();
      expect(() =>
        decryptFieldText(
          key,
          simonField(owner, "messages", String(row?.id), "request_fingerprint_enc"),
          String(row?.content_enc),
        ),
      ).toThrow();
    } finally {
      zeroize(key.key);
    }
  });
});

describe("execution fencing and checkpoints", () => {
  it("conditionally claims a run only once", async () => {
    const accepted = await send();
    const claims = await Promise.all([
      repository.claim(accepted.runId ?? "", "local"),
      repository.claim(accepted.runId ?? "", "local"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    for (const claimed of claims) if (claimed) zeroize(claimed.key.key);
  });
  it("refuses the wrong executor and retired generations", async () => {
    const accepted = await send();
    expect(await repository.claim(accepted.runId ?? "", "trigger")).toBeNull();
    await env.db.run(sql("UPDATE executor_state SET generation = generation + 1 WHERE id = 1"));
    expect(await repository.claim(accepted.runId ?? "", "local")).toBeNull();
  });
  it.each(["archive", "relock", "stop", "switch"])(
    "does not execute after %s",
    async (operation) => {
      const claimed = await claim();
      try {
        expect(await repository.mayExecute(claimed.run)).toBe(true);
        if (operation === "archive") await env.archiveTask(task);
        if (operation === "relock") await env.relock(owner);
        if (operation === "stop") await repository.stop(owner, claimed.run.id);
        if (operation === "switch")
          await env.db.run(
            sql("UPDATE executor_state SET generation = generation + 1 WHERE id = 1"),
          );
        expect(await repository.mayExecute(claimed.run)).toBe(false);
        expect(await repository.checkpoint(claimed.run, claimed.key, "must not save", 1)).toBe(
          false,
        );
        expect(await env.count("messages")).toBe(1);
      } finally {
        zeroize(claimed.key.key);
      }
    },
  );
  it("checkpoints one assistant message independently of any viewer", async () => {
    const claimed = await claim();
    try {
      expect(await repository.checkpoint(claimed.run, claimed.key, "partial", 1)).toBe(true);
      expect(
        await repository.checkpoint(claimed.run, claimed.key, "finished", 2, "completed"),
      ).toBe(true);
      expect(await env.count("messages")).toBe(2);
      expect((await repository.history(owner, conversation)).at(-1)?.text).toBe("finished");
      expect((await repository.run(owner, claimed.run.id))?.status).toBe("completed");
      expect(
        (
          await env.db.first(
            sql("SELECT active_run_id FROM conversations WHERE id = :id", { id: conversation }),
          )
        )?.active_run_id,
      ).toBeNull();
      expect(await repository.checkpoint(claimed.run, claimed.key, "late", 3, "completed")).toBe(
        false,
      );
    } finally {
      zeroize(claimed.key.key);
    }
  });
  it("starts only the oldest queued message in the completion batch", async () => {
    const claimed = await claim();
    try {
      const second = await send("second", "second text");
      const third = await send("third", "third text");
      expect(
        await repository.checkpoint(claimed.run, claimed.key, "first answer", 1, "completed"),
      ).toBe(true);
      const history = await repository.history(owner, conversation);
      expect(history.find((m) => m.id === second.messageId)).toMatchObject({ status: "accepted" });
      expect(history.find((m) => m.id === third.messageId)).toMatchObject({
        status: "queued",
        runId: null,
      });
      expect(await env.count("runs")).toBe(2);
      expect(await env.count("dispatch_intents")).toBe(2);
    } finally {
      zeroize(claimed.key.key);
    }
  });
  it("preserves partial output on stop and advances queued work", async () => {
    const claimed = await claim();
    try {
      await repository.checkpoint(claimed.run, claimed.key, "partial", 1);
      await send("second");
      await repository.stop(owner, claimed.run.id);
      expect((await repository.run(owner, claimed.run.id))?.status).toBe("running");
      expect(
        await repository.checkpoint(claimed.run, claimed.key, "partial preserved", 1, "stopped"),
      ).toBe(true);
      expect((await repository.run(owner, claimed.run.id))?.status).toBe("stopped");
      expect(await env.count("runs")).toBe(2);
      expect(
        (await repository.history(owner, conversation)).find((m) => m.role === "assistant")?.text,
      ).toBe("partial preserved");
    } finally {
      zeroize(claimed.key.key);
    }
  });
  it("stops an undispatched run and cancels its intent", async () => {
    const accepted = await send();
    await repository.stop(owner, accepted.runId ?? "");
    expect((await repository.run(owner, accepted.runId ?? ""))?.status).toBe("stopped");
    expect(
      (
        await env.db.first(
          sql("SELECT status FROM dispatch_intents WHERE subject_id = :run", {
            run: accepted.runId,
          }),
        )
      )?.status,
    ).toBe("cancelled");
    expect(await repository.claim(accepted.runId ?? "", "local")).toBeNull();
  });
  it("refuses a foreign stop without changing the run", async () => {
    const accepted = await send();
    const stranger = await env.createUser();
    await expect(repository.stop(stranger, accepted.runId ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await repository.run(owner, accepted.runId ?? ""))?.status).toBe("queued");
  });
  it("cannot claim an expired quick chat", async () => {
    conversation = await repository.createConversation(owner, null);
    const accepted = await send();
    env.clock += 86_400_000;
    expect(await repository.claim(accepted.runId ?? "", "local")).toBeNull();
  });
  it("does not revive queued work after access loss", async () => {
    const claimed = await claim();
    try {
      await send("second");
      await env.relock(owner);
      await env.db.batch([
        sql("UPDATE runs SET status = 'interrupted', write_id = :w WHERE id = :run", {
          w: "reconcile",
          run: claimed.run.id,
        }),
        ...repository.releaseStatements(claimed.run.id, "reconcile", env.clock),
      ]);
      expect(await env.count("runs")).toBe(1);
    } finally {
      zeroize(claimed.key.key);
    }
  });
  it("uses a matching durable generation without executing locally", async () => {
    await env.db.run(
      sql("UPDATE executor_state SET mode = 'durable', generation = :generation WHERE id = 1", {
        generation: int(2),
      }),
    );
    const accepted = await send();
    expect(await repository.claim(accepted.runId ?? "", "local")).toBeNull();
    const claimed = await repository.claim(accepted.runId ?? "", "trigger");
    expect(claimed?.run).toMatchObject({ executor: "trigger", generation: 2 });
    if (claimed) zeroize(claimed.key.key);
  });
});

describe("cross-domain stop and deletion", () => {
  it("expires a paused run and its queued messages on restriction without a continuation", async () => {
    const accepted = await send();
    await send("queued");
    await env.db.run(
      sql("UPDATE runs SET status = 'awaiting_user' WHERE id = :id", { id: accepted.runId }),
    );
    const writeId = uuidv7(env.clock);
    await env.db.batch([
      sql("UPDATE users SET beta_state = 'relocked', write_id = :w WHERE id = :owner", {
        owner,
        w: writeId,
      }),
      ...simonRestrictContributor.statements({
        userId: owner,
        writeId,
        now: env.clock,
        reason: "relocked",
      }),
    ]);
    expect(
      (await env.db.first(sql("SELECT status FROM runs WHERE id = :id", { id: accepted.runId })))
        ?.status,
    ).toBe("stopped");
    expect(
      (
        await env.db.first(
          sql("SELECT active_run_id FROM conversations WHERE id = :id", { id: conversation }),
        )
      )?.active_run_id,
    ).toBeNull();
    expect(
      (await env.db.first(sql("SELECT status FROM messages WHERE request_id = 'queued'")))?.status,
    ).toBe("cancelled");
    expect(await env.count("runs")).toBe(1);
    expect((await env.db.first(sql("SELECT status FROM dispatch_intents")))?.status).toBe(
      "cancelled",
    );
  });
  it("archive stops only the chosen task with its deciding write id", async () => {
    const accepted = await send();
    const otherTask = await env.createTask(owner);
    const otherConversation = await repository.createConversation(owner, otherTask);
    const other = await repository.acceptMessage(owner, otherConversation, "other", {
      text: "keep working",
      tier: "fast",
    });
    const writeId = uuidv7(env.clock);
    const input = {
      ownerId: owner,
      rootTaskId: task,
      taskIds: [task],
      mode: "all" as const,
      writeId,
      now: env.clock,
      stopRun: true,
      archivedTaskIds: {
        sql: "SELECT id FROM tasks WHERE id = :archived_task",
        params: { archived_task: task },
      },
    };
    await env.db.batch(simonArchiveContributor.statements(input));
    expect((await repository.run(owner, accepted.runId ?? ""))?.status).toBe("queued");
    await env.db.batch([
      sql("UPDATE users SET task_tree_write_id = :w WHERE id = :owner", { owner, w: writeId }),
      ...simonArchiveContributor.statements(input),
    ]);
    expect((await repository.run(owner, accepted.runId ?? ""))?.status).toBe("stopped");
    expect((await repository.run(owner, other.runId ?? ""))?.status).toBe("queued");
    expect(
      (
        await env.db.first(
          sql("SELECT active_run_id FROM conversations WHERE id = :id", { id: otherConversation }),
        )
      )?.active_run_id,
    ).toBe(other.runId);
  });
  it("purges bounded batches children first without touching another owner's history", async () => {
    const claimed = await claim();
    await repository.checkpoint(claimed.run, claimed.key, "saved answer", 1, "completed");
    zeroize(claimed.key.key);
    const stranger = await env.createUser();
    const strangerConversation = await repository.createConversation(stranger, null);
    await repository.acceptMessage(stranger, strangerConversation, "keep", {
      text: "retain me",
      tier: "fast",
    });
    let remaining = true;
    for (let attempt = 0; attempt < 10 && remaining; attempt += 1) {
      const input = { userId: owner, batchLimit: 1 };
      const results = await env.db.batch([
        ...simonPurgeContributor.statements(input),
        ...(simonPurgeContributor.remaining?.(input) ?? []),
      ]);
      remaining = results.at(-1)?.results[0]?.remaining === 1;
    }
    expect(remaining).toBe(false);
    expect(await repository.history(stranger, strangerConversation)).toMatchObject([
      { text: "retain me" },
    ]);
    expect(await env.count("conversations")).toBe(1);
    expect(await env.count("runs")).toBe(1);
    expect(await env.count("messages")).toBe(1);
  });
  it("cannot claim a run after its account key is shredded", async () => {
    const accepted = await send();
    await env.db.run(sql("DELETE FROM account_keys WHERE owner_id = :owner", { owner }));
    expect(await repository.claim(accepted.runId ?? "", "local")).toBeNull();
    expect((await repository.run(owner, accepted.runId ?? ""))?.status).toBe("queued");
  });
});

describe("executor lifecycle and relay", () => {
  it("relays only persisted run identity and current lifecycle state", async () => {
    const accepted = await send();
    const relay = new SimonRunRelaySource(env.db);
    expect(await relay.ownership(accepted.runId ?? "")).toEqual({
      runId: accepted.runId,
      ownerId: owner,
      conversationId: conversation,
    });
    expect(await relay.state(accepted.runId ?? "")).toEqual({
      status: "queued",
      executorGeneration: 1,
    });
    expect(await relay.ownership(uuidv7())).toBeNull();
    expect(await relay.state(uuidv7())).toBeNull();
  });
  it("records dispatch idempotently without claiming or starting the model", async () => {
    const accepted = await send();
    const tracker = new SimonExecutionTracker(env.db);
    const dispatch = {
      executor: "local" as const,
      triggerRunId: null,
      generation: 1,
      now: env.clock,
    };
    await tracker.recordDispatch(accepted.runId ?? "", dispatch);
    await tracker.recordDispatch(accepted.runId ?? "", dispatch);
    expect((await repository.run(owner, accepted.runId ?? ""))?.status).toBe("queued");
    expect(await tracker.listActive({ executor: "local", limit: 20 })).toMatchObject([
      { subjectId: accepted.runId, ownerId: owner, heartbeatAt: env.clock },
    ]);
    expect(await tracker.listActive({ executor: "trigger", limit: 20 })).toEqual([]);
    expect(
      await tracker.listActive({ executor: "local", limit: 20, ownerId: await env.createUser() }),
    ).toEqual([]);
    expect(
      await tracker.listActive({ executor: "local", limit: 20, after: accepted.runId ?? "" }),
    ).toEqual([]);
  });
  it("chunks heartbeats below D1's parameter limit and ignores retired generations", async () => {
    const active = await claim();
    try {
      const tracker = new SimonExecutionTracker(env.db);
      env.clock += 20_000;
      await tracker.recordHeartbeat(
        [active.run.id, ...Array.from({ length: 200 }, () => uuidv7())],
        env.clock,
      );
      expect(
        (
          await env.db.first(
            sql("SELECT heartbeat_at FROM runs WHERE id = :id", { id: active.run.id }),
          )
        )?.heartbeat_at,
      ).toBe(env.clock);
      await env.db.run(sql("UPDATE executor_state SET generation = generation + 1"));
      await tracker.recordHeartbeat([active.run.id], env.clock + 20_000);
      expect(
        (
          await env.db.first(
            sql("SELECT heartbeat_at FROM runs WHERE id = :id", { id: active.run.id }),
          )
        )?.heartbeat_at,
      ).toBe(env.clock);
      await tracker.recordDispatch(active.run.id, {
        executor: "local",
        triggerRunId: null,
        generation: 2,
        now: env.clock,
      });
      expect((await repository.run(owner, active.run.id))?.generation).toBe(1);
    } finally {
      zeroize(active.key.key);
    }
  });
  it("interrupts process loss and advances queued work in one batch", async () => {
    const active = await claim();
    try {
      await repository.checkpoint(active.run, active.key, "keep this partial response", 1);
      await send("follow-up");
      const tracker = new SimonExecutionTracker(env.db);
      expect(
        await tracker.markInterrupted(active.run.id, {
          outcomeCode: "executor_lost",
          now: env.clock,
        }),
      ).toBe(true);
      expect(
        await tracker.markInterrupted(active.run.id, {
          outcomeCode: "executor_lost",
          now: env.clock,
        }),
      ).toBe(false);
      expect((await repository.run(owner, active.run.id))?.status).toBe("interrupted");
      expect(await env.count("runs")).toBe(2);
      expect(
        (await repository.history(owner, conversation)).find(
          (message) => message.role === "assistant",
        )?.text,
      ).toBe("keep this partial response");
      expect(
        (
          await env.db.first(
            sql("SELECT status FROM dispatch_intents WHERE subject_id = :id", {
              id: active.run.id,
            }),
          )
        )?.status,
      ).toBe("cancelled");
    } finally {
      zeroize(active.key.key);
    }
  });
  it("does not override a completed checkpoint and requires a stop request", async () => {
    const active = await claim();
    try {
      const tracker = new SimonExecutionTracker(env.db);
      expect(await tracker.markStopped(active.run.id, { now: env.clock })).toBe(false);
      await repository.checkpoint(active.run, active.key, "finished", 1, "completed");
      expect(
        await tracker.markInterrupted(active.run.id, {
          outcomeCode: "executor_failed",
          now: env.clock,
        }),
      ).toBe(false);
      expect((await repository.run(owner, active.run.id))?.status).toBe("completed");
    } finally {
      zeroize(active.key.key);
    }
  });
  it("reports an interrupted cancellation as stopped after the local process dies", async () => {
    const active = await claim();
    try {
      await repository.stop(owner, active.run.id);
      const tracker = new SimonExecutionTracker(env.db);
      expect(
        await tracker.markInterrupted(active.run.id, {
          outcomeCode: "executor_lost",
          now: env.clock,
        }),
      ).toBe(true);
      expect((await repository.run(owner, active.run.id))?.status).toBe("stopped");
    } finally {
      zeroize(active.key.key);
    }
  });
  it("honors self-hosted beta policy when advancing a queue", async () => {
    repository = new SimonRepository({
      ...repository.options,
      policy: { betaAccessRequired: false },
    });
    await env.db.run(sql("UPDATE users SET beta_state = 'locked' WHERE id = :owner", { owner }));
    const active = await claim();
    try {
      await send("next");
      const tracker = new SimonExecutionTracker(env.db, { betaAccessRequired: false });
      expect(
        await tracker.markInterrupted(active.run.id, {
          outcomeCode: "executor_lost",
          now: env.clock,
        }),
      ).toBe(true);
      expect(await env.count("runs")).toBe(2);
    } finally {
      zeroize(active.key.key);
    }
  });
});
