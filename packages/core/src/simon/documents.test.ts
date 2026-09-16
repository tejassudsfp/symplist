import { encryptFieldText } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { taskTitleContext } from "../tasks/sql.ts";
import { SimonDocumentSession } from "./documents.ts";
import { SimonRepository } from "./repository.ts";
import type { ClaimedSimonRun } from "./types.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
let claim: ClaimedSimonRun;
let session: SimonDocumentSession;
let taskId: string;
let revision: string;
let sectionId: string;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  await env.db.run(sql("UPDATE executor_state SET mode = 'local'"));
  const owner = await env.createUser();
  taskId = await env.createTask(owner);
  repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
    quickChatTtlHours: 24,
  });
  const key = await repository.accountKeys.require(owner);
  try {
    await env.db.run(
      sql("UPDATE tasks SET title_enc = :title WHERE id = :task", {
        task: taskId,
        title: encryptFieldText(key, taskTitleContext(owner, taskId), "Task title only"),
      }),
    );
  } finally {
    key.key.fill(0);
  }
  revision = String(
    (
      await env.tools.updateSection(env.simon(owner, taskId), {
        taskId,
        expectedRevision: null,
        placement: "end",
        markdown: "## Notes\nSecret document body",
      })
    ).revision,
  );
  sectionId = String(
    (await env.tools.outline(env.simon(owner, taskId), { taskId })).entries[0]?.sectionId,
  );
  const conversation = await repository.createConversation(owner, taskId);
  const accepted = await repository.acceptMessage(owner, conversation, "doc-test", {
    text: "Read the section",
    tier: "fast",
  });
  const claimed = await repository.claim(String(accepted.runId), "local");
  if (!claimed) throw new Error("missing claim");
  claim = claimed;
  session = await SimonDocumentSession.create({ repository, claim, tools: env.tools, git: null });
});
afterEach(async () => {
  if (claim) repository.releaseClaim(claim);
  await env.close();
});

async function read() {
  const result = await env.tools.readSection(
    session.actor("read_section"),
    { taskId, sectionId, revision },
    { budget: session.budget },
  );
  session.stageReceipt("read_section", result.receipt);
  return result;
}
function snapshot() {
  return {
    ...session.checkpointData(["read_section"]),
    snapshotJson: JSON.stringify({
      id: claim.run.id,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "task_document_read_section",
          toolCallId: "read_section",
          state: "output-available",
          input: { taskId, sectionId, revision },
          output: "Secret document body",
        },
      ],
    }),
  };
}

describe("Simon document checkpoint authority", () => {
  it("does not record a completed read whose result was lost to Stop before the step checkpoint", async () => {
    await read();
    await repository.stop(claim.run.ownerId, claim.run.id);
    const data = {
      ...session.checkpointData([]),
      snapshotJson: JSON.stringify({ id: claim.run.id, role: "assistant", parts: [] }),
    };
    expect(await repository.checkpoint(claim.run, claim.key, "", 0, "stopped", data)).toBe(true);
    expect(await env.count("read_receipts")).toBe(0);
    expect(await env.count("message_parts")).toBe(1);
  });
  it("commits receipts and retrieved bytes only with the encrypted tool-result checkpoint", async () => {
    await read();
    expect(await env.count("read_receipts")).toBe(0);
    expect(await repository.checkpoint(claim.run, claim.key, "", 1, "running", snapshot())).toBe(
      true,
    );
    expect(await env.count("read_receipts")).toBe(1);
    const parts = await env.db.all(sql("SELECT * FROM message_parts"));
    expect(JSON.stringify(parts)).not.toContain("Secret document body");
    expect(parts[0]?.content_enc).toMatch(/^sym1\./);
    expect(await repository.checkpoint(claim.run, claim.key, "", 1, "completed", snapshot())).toBe(
      true,
    );
    expect(await env.count("read_receipts")).toBe(1);
    expect(
      (
        await env.db.first(
          sql("SELECT retrieved_bytes FROM runs WHERE id = :id", { id: claim.run.id }),
        )
      )?.retrieved_bytes,
    ).toBe(session.budget.totalBytes);
  });
  it.each(["stop", "relock", "generation", "archive"] as const)(
    "persists neither a receipt nor a tool result when %s wins the checkpoint",
    async (race) => {
      await read();
      if (race === "stop") await repository.stop(claim.run.ownerId, claim.run.id);
      if (race === "relock") await env.relock(claim.run.ownerId);
      if (race === "generation")
        await env.db.run(sql("UPDATE executor_state SET generation = generation + 1"));
      if (race === "archive") await env.archiveTask(taskId);
      expect(await repository.checkpoint(claim.run, claim.key, "", 1, "running", snapshot())).toBe(
        false,
      );
      expect(await env.count("read_receipts")).toBe(0);
      expect(await env.count("message_parts")).toBe(0);
    },
  );
  it("binds staged receipts to the run owner, conversation and result snapshot", async () => {
    const readResult = await read();
    if (!readResult.receipt) throw new Error("missing receipt");
    for (const patch of [
      { ownerId: "other" },
      { runId: "other" },
      { reader: { kind: "conversation" as const, id: "other" } },
    ]) {
      await expect(
        repository.checkpoint(claim.run, claim.key, "", 1, "running", {
          ...snapshot(),
          receipts: [{ ...readResult.receipt, ...patch }],
        }),
      ).rejects.toMatchObject({ code: "validation" });
    }
    await expect(
      repository.checkpoint(
        claim.run,
        claim.key,
        "",
        1,
        "running",
        session.checkpointData(["read_section"]),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(await env.count("read_receipts")).toBe(0);
  });
  it("context exposes title and read positions but never automatically includes page body", async () => {
    const context = await session.context(taskId, "context");
    expect(context).toMatchObject({
      title: "Task title only",
      revision,
      sections: [{ state: "unread" }],
    });
    expect(JSON.stringify(context)).not.toContain("Secret document body");
    const other = await env.createUser();
    const foreignTask = await env.createTask(other);
    await expect(session.context(foreignTask, "foreign_context")).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("fences the deciding local document publication, not only the pre-tool read", async () => {
    const actor = session.actor("stale_edit");
    await repository.stop(claim.run.ownerId, claim.run.id);
    await expect(
      env.tools.updateSection(actor, {
        taskId,
        expectedRevision: revision,
        sectionId,
        placement: "replace",
        markdown: "## Stale",
      }),
    ).rejects.toMatchObject({ code: "document.read_only" });
    expect(await env.count("doc_commits")).toBe(1);
  });
});
