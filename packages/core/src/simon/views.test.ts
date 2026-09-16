import { zeroize } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonRepository } from "./repository.ts";
import { SimonUserAsks } from "./user-asks.ts";
import { SimonViews, visibleSimonParts } from "./views.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
let views: SimonViews;
let owner: string;
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
  views = new SimonViews(repository);
  await env.db.run(sql("UPDATE executor_state SET mode = 'local' WHERE id = 1"));
  owner = await env.createUser();
  conversation = await repository.createConversation(owner, null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env?.close();
});

async function turn(request: string, output = "Visible answer") {
  const sent = await repository.acceptMessage(owner, conversation, request, {
    text: "Visible question",
    tier: "fast",
  });
  const claim = await repository.claim(sent.runId ?? "", "local");
  if (!claim) throw new Error("Expected claim");
  try {
    await repository.checkpoint(claim.run, claim.key, "Visible answer", 1, "completed", {
      snapshotJson: JSON.stringify({
        id: claim.run.id,
        role: "assistant",
        parts: [
          { type: "reasoning", text: "hidden-reasoning-marker" },
          {
            type: "text",
            text: "Visible answer",
            providerMetadata: { secret: "hidden-provider-marker" },
          },
          {
            type: "dynamic-tool",
            toolName: "task_context",
            toolCallId: "tool_1",
            state: "output-available",
            input: { secret: "hidden-input-marker" },
            output,
            providerMetadata: { secret: "hidden-provider-marker" },
          },
        ],
      }),
    });
    return sent;
  } finally {
    zeroize(claim.key.key);
  }
}

describe("public Simon history", () => {
  it("restores persisted question resolution cards without hidden provider fields", async () => {
    const sent = await repository.acceptMessage(owner, conversation, "question", {
      text: "Ask me",
      tier: "fast",
    });
    const paused = await repository.claim(sent.runId ?? "", "local");
    if (!paused) throw new Error("Expected claim");
    const asks = new SimonUserAsks(repository);
    let askId: string;
    try {
      askId = await asks.pause(
        paused.run,
        paused.key,
        { question: "Which?", toolCallId: "ask" },
        {
          text: "Which?",
          steps: 1,
          snapshotJson: JSON.stringify({
            id: paused.run.id,
            role: "assistant",
            parts: [{ type: "text", text: "Which?" }],
          }),
        },
      );
    } finally {
      zeroize(paused.key.key);
    }
    const continuationId = await asks.decide(owner, askId, { kind: "answer", text: "First" });
    const continuation = await repository.claim(continuationId, "local");
    if (!continuation) throw new Error("Expected continuation");
    try {
      expect(
        await repository.resolvePauseSnapshot(
          continuation.run,
          continuation.key,
          paused.run.id,
          JSON.stringify({
            id: paused.run.id,
            role: "assistant",
            parts: [
              { type: "reasoning", text: "hidden-provider-reasoning" },
              {
                type: "data-user-answer",
                data: {
                  status: "answered",
                  text: "First",
                  providerMetadata: "hidden-provider-field",
                },
              },
            ],
          }),
        ),
      ).toBe(true);
    } finally {
      zeroize(continuation.key.key);
    }
    const history = await views.conversation(owner, conversation);
    expect(history.messages.find((message) => message.id === paused.run.id)?.parts).toEqual([
      { type: "data-user-answer", data: { status: "answered", text: "First" } },
    ]);
    expect(JSON.stringify(history)).not.toContain("hidden-provider");
    expect(
      visibleSimonParts(
        JSON.stringify({
          parts: [
            {
              type: "data-approval-result",
              data: { status: "uncertain", providerMetadata: "hidden-provider-field" },
            },
            { type: "data-unreviewed", data: "hidden-provider-field" },
          ],
        }),
        "",
      ),
    ).toEqual([{ type: "data-approval-result", data: { status: "uncertain" } }]);
  });
  it("projects encrypted history in one batch without reasoning, inputs or provider metadata", async () => {
    await turn("one");
    const spy = vi.spyOn(env.db, "batch");
    const result = await views.conversation(owner, conversation);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "quick",
      activeRun: null,
      pendingApprovalId: null,
      pendingAskId: null,
      nextBeforeSeq: null,
    });
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.messages[1]?.parts).toEqual([
      { type: "text", text: "Visible answer" },
      {
        type: "tool",
        toolName: "task_context",
        toolCallId: "tool_1",
        state: "output-available",
        output: "Visible answer",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("hidden-");
    expect(
      JSON.stringify(await env.db.all(sql("SELECT content_enc FROM message_parts"))),
    ).not.toContain("Visible");
  });
  it("returns the current run and distinguishes queued messages", async () => {
    const sent = await repository.acceptMessage(owner, conversation, "first", {
      text: "First",
      tier: "smart",
    });
    await repository.acceptMessage(owner, conversation, "second", { text: "Second", tier: "fast" });
    const result = await views.conversation(owner, conversation);
    expect(result.activeRun).toMatchObject({
      runId: sent.runId,
      status: "queued",
      tier: "smart",
      stopRequested: false,
    });
    expect(result.messages.map((message) => message.status)).toEqual(["accepted", "queued"]);
  });
  it.each(["foreign", "expired", "relocked", "shredded"])("refuses %s history", async (reason) => {
    await turn("one");
    let reader = owner;
    if (reason === "foreign") reader = await env.createUser();
    if (reason === "expired") env.clock += 24 * 3_600_000;
    if (reason === "relocked") await env.relock(owner);
    if (reason === "shredded")
      await env.db.run(sql("DELETE FROM account_keys WHERE owner_id = :owner", { owner }));
    expect(await views.owns(reader, conversation)).toBe(false);
    await expect(views.conversation(reader, conversation)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("paginates by sequence without dropping byte-bounded large snapshots", async () => {
    for (let index = 0; index < 3; index += 1) await turn(`large-${index}`, "x".repeat(800_000));
    const seen: number[] = [];
    let before: number | undefined;
    for (let index = 0; index < 10; index += 1) {
      const page = await views.conversation(owner, conversation, before);
      expect(page.messages.length).toBeLessThan(6);
      seen.push(...page.messages.map((message) => message.seq));
      if (page.nextBeforeSeq === null) break;
      before = page.nextBeforeSeq;
    }
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(seen).size).toBe(6);
  });
  it("refuses malformed cursors", async () => {
    for (const cursor of [0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      await expect(views.conversation(owner, conversation, cursor)).rejects.toMatchObject({
        code: "validation",
      });
  });
  it("maps tool errors to a stable code and drops unknown provider parts", () => {
    expect(
      visibleSimonParts(
        JSON.stringify({
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "t",
              toolName: "action",
              state: "output-error",
              errorText: "provider-private-marker",
            },
            { type: "file", url: "provider-private-marker" },
          ],
        }),
        "",
      ),
    ).toEqual([
      {
        type: "tool",
        toolCallId: "t",
        toolName: "action",
        state: "output-error",
        errorCode: "tool.failed",
      },
    ]);
  });
});
