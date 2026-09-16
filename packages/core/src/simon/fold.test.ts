import { randomBytes } from "node:crypto";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import { sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { IdempotencyStore } from "../idempotency/store.ts";
import type { SimonWriteFold } from "./fold.ts";
import { SimonRepository } from "./repository.ts";
import { SimonError } from "./types.ts";

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

describe("Simon folded HTTP writes", () => {
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
