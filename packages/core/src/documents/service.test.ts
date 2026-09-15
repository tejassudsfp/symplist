import { sql } from "@symplist/db";
import { DocumentError, type PublicationFold } from "@symplist/docs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentAccessDeniedError } from "./context.ts";
import { createDocumentsTestEnvironment, type DocumentsTestEnvironment } from "./test-support.ts";
import type { PublishResult } from "./views.ts";

let env: DocumentsTestEnvironment;
let owner: string;
let task: string;
let requests = 0;

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  task = await env.createTask(owner);
});

afterEach(async () => {
  await env.close();
});

async function save(
  markdown: string,
  base: string | null,
  extra: { draftSeq?: number; kind?: "edit" | "normalization" } = {},
) {
  requests += 1;
  const outcome = await env.service.save(
    env.user(owner),
    {
      taskId: task,
      baseRevision: base,
      markdown,
      kind: extra.kind ?? "edit",
      ...(extra.draftSeq === undefined ? {} : { draftSeq: extra.draftSeq }),
    },
    { id: `save-${requests}` },
  );
  if (outcome.kind !== "result") throw new Error("unexpected replay");
  env.clock += 5_000;
  return outcome.result;
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
}

const portfolio = `## Overview
A lighter, quieter portfolio.

## Projects to feature
- [x] Field notes app

## Next steps
1. Draft the about page
`;

describe("head and saves (§9.2, §9.3)", () => {
  it("shows the empty page, then the saved head with sections, and announces the change", async () => {
    const empty = await env.service.getHead(env.user(owner), task);
    expect(empty).toMatchObject({
      revision: null,
      markdown: "",
      sections: [],
      draft: null,
      generation: 0,
    });

    const saved = await save(portfolio, null);
    expect(saved).toMatchObject({ status: "published", generation: 1 });
    const head = await env.service.getHead(env.user(owner), task);
    expect(head).toMatchObject({
      revision: saved.revision,
      markdown: portfolio,
      author: "user",
      canonical: false,
    });
    expect(head.sections.map((section) => section.heading)).toEqual([
      "Overview",
      "Projects to feature",
      "Next steps",
    ]);
    expect(env.events).toEqual([
      expect.objectContaining({
        ownerId: owner,
        taskId: task,
        revision: saved.revision,
        author: "user",
        generation: 1,
      }),
    ]);
  });

  it("creates no commit for unchanged content and never commits drafts (no keystroke flooding)", async () => {
    const first = await save(portfolio, null);
    for (let seq = 1; seq <= 5; seq += 1) {
      await env.service.putDraft(env.user(owner), {
        taskId: task,
        baseRevision: first.revision,
        clientSeq: seq,
        markdown: `${portfolio}typing ${seq}`,
      });
      env.clock += 2_500;
    }
    const unchanged = await save(portfolio, first.revision, { draftSeq: 5 });
    expect(unchanged).toMatchObject({
      status: "unchanged",
      revision: first.revision,
      changedSectionIds: [],
    });
    expect(await env.count("doc_commits")).toBe(1);
    expect((await env.service.getHead(env.user(owner), task)).draft).toBeNull();
  });

  it("clears the covered draft with the publication but keeps a newer one", async () => {
    const first = await save("# One\n", null);
    await env.service.putDraft(env.user(owner), {
      taskId: task,
      baseRevision: first.revision,
      clientSeq: 7,
      markdown: "# One\n\nnewer",
    });
    await save("# One\n\nolder\n", first.revision, { draftSeq: 3 });
    expect((await env.service.getHead(env.user(owner), task)).draft).toMatchObject({
      clientSeq: 7,
      origin: "editor",
    });
  });

  it("returns a conflict with the current revision and preserves the candidate as the draft", async () => {
    const first = await save("# One\n", null);
    const second = await save("# One\n\nFrom another tab\n", first.revision);
    const error = await failure(
      env.service.save(
        env.user(owner),
        {
          taskId: task,
          baseRevision: first.revision,
          markdown: "# One\n\nMy typing\n",
          kind: "edit",
          draftSeq: 4,
        },
        { id: "save-conflict" },
      ),
    );
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).code).toBe("document.conflict");
    expect((error as DocumentError).details).toEqual({
      currentRevision: second.revision,
      currentGeneration: 2,
      draftPreserved: true,
    });
    const head = await env.service.getHead(env.user(owner), task);
    expect(head.markdown).toBe("# One\n\nFrom another tab\n");
    expect(head.draft).toMatchObject({
      markdown: "# One\n\nMy typing\n",
      origin: "conflict",
      baseRevision: first.revision,
      clientSeq: 4,
    });
  });

  it("refuses oversized documents before any D1 access", async () => {
    const small = await createDocumentsTestEnvironment({ repository: { docMaxBytes: 1_024 } });
    try {
      const user = await small.createUser();
      const taskId = await small.createTask(user);
      let batches = 0;
      const original = small.db.batch.bind(small.db);
      small.db.batch = async (...args) => {
        batches += 1;
        return original(...args);
      };
      const error = await failure(
        small.service.save(
          small.user(user),
          { taskId, baseRevision: null, markdown: "é".repeat(600), kind: "edit" },
          { id: "big" },
        ),
      );
      expect((error as DocumentError).code).toBe("document.too_large");
      expect(batches).toBe(0);
    } finally {
      await small.close();
    }
  });

  it("folds an idempotency claim: completion on success, replay on retry, release on a lost race", async () => {
    const recorded: Array<{ status: string; body: unknown; guarded: boolean }> = [];
    let replayBody: unknown = null;
    const fold = (): PublicationFold => ({
      prefix: [sql(`SELECT 1 AS claim`)],
      suffix: ({ outcome, headGuard }) => {
        recorded.push({ status: outcome.status, body: outcome, guarded: headGuard !== null });
        return [sql(`SELECT 2 AS completion`)];
      },
      inspect: () => (replayBody ? { replay: replayBody } : null),
    });
    const first = await env.service.save(
      env.user(owner),
      { taskId: task, baseRevision: null, markdown: "# A\n", kind: "edit" },
      { id: "k1", fold: fold() },
    );
    expect(first.kind).toBe("result");
    expect(recorded.at(-1)).toMatchObject({ status: "published", guarded: true });
    const unchanged = await env.service.save(
      env.user(owner),
      {
        taskId: task,
        baseRevision: (first as { result: PublishResult }).result.revision,
        markdown: "# A\n",
        kind: "edit",
      },
      { id: "k2", fold: fold() },
    );
    expect(unchanged.kind).toBe("result");
    expect(recorded.at(-1)).toMatchObject({ status: "unchanged", guarded: false });
    replayBody = { recorded: true };
    const replay = await env.service.save(
      env.user(owner),
      { taskId: task, baseRevision: null, markdown: "# A\n", kind: "edit" },
      { id: "k1", fold: fold() },
    );
    expect(replay).toEqual({ kind: "replay", body: { recorded: true } });
  });
});

describe("authorization (§5.4, §2.1)", () => {
  it("returns not_found for another user's task and never reveals it", async () => {
    await save("# Private plan\n", null);
    const intruder = await env.createUser();
    for (const attempt of [
      env.service.getHead(env.user(intruder), task),
      env.service.history(env.user(intruder), { taskId: task }),
      env.service.putDraft(env.user(intruder), {
        taskId: task,
        baseRevision: null,
        clientSeq: 1,
        markdown: "x",
      }),
      env.service.save(
        env.user(intruder),
        { taskId: task, baseRevision: null, markdown: "x", kind: "edit" },
        { id: "x" },
      ),
    ]) {
      const error = await failure(attempt);
      expect((error as DocumentError).code).toBe("not_found");
      expect(JSON.stringify(error)).not.toContain("Private plan");
    }
  });

  it("refuses relocked owners and writes to archived tasks while allowing archived reads", async () => {
    const first = await save("# One\n", null);
    await env.archiveTask(task);
    expect((await env.service.getHead(env.user(owner), task)).revision).toBe(first.revision);
    const archived = await failure(
      env.service.save(
        env.user(owner),
        { taskId: task, baseRevision: first.revision, markdown: "# Two\n", kind: "edit" },
        { id: "a" },
      ),
    );
    expect((archived as DocumentError).code).toBe("task.archived");
    await env.relock(owner);
    const relocked = await failure(env.service.getHead(env.user(owner), task));
    expect(relocked).toBeInstanceOf(DocumentAccessDeniedError);
    expect((relocked as DocumentAccessDeniedError).code).toBe("access.relocked");
  });
});

describe("drafts (§9.3)", () => {
  it("orders writes by client sequence, throttles, and deletes idempotently", async () => {
    await env.service.putDraft(env.user(owner), {
      taskId: task,
      baseRevision: null,
      clientSeq: 5,
      markdown: "five",
    });
    const throttled = await failure(
      env.service.putDraft(env.user(owner), {
        taskId: task,
        baseRevision: null,
        clientSeq: 6,
        markdown: "six",
      }),
    );
    expect((throttled as DocumentError).code).toBe("rate.limited");
    env.clock += 3_000;
    const stale = await failure(
      env.service.putDraft(env.user(owner), {
        taskId: task,
        baseRevision: null,
        clientSeq: 4,
        markdown: "four",
      }),
    );
    expect((stale as DocumentError).code).toBe("document.draft_stale");
    env.clock += 3_000;
    await env.service.putDraft(env.user(owner), {
      taskId: task,
      baseRevision: null,
      clientSeq: 6,
      markdown: "six",
    });
    expect((await env.service.getHead(env.user(owner), task)).draft).toMatchObject({
      markdown: "six",
      clientSeq: 6,
    });
    await env.service.deleteDraft(env.user(owner), task, 5);
    expect((await env.service.getHead(env.user(owner), task)).draft).not.toBeNull();
    await env.service.deleteDraft(env.user(owner), task, 6);
    await env.service.deleteDraft(env.user(owner), task, 6);
    expect((await env.service.getHead(env.user(owner), task)).draft).toBeNull();
    const raw = JSON.stringify(await env.db.all(sql(`SELECT * FROM doc_drafts`)));
    expect(raw).not.toContain("six");
  });
});

describe("history, previews, compare and restore (§9.2)", () => {
  it("pages history with the head pinned while new revisions arrive", async () => {
    let base: string | null = null;
    const revisions: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      const result = await save(`# Plan\n\nstep ${n}\n`, base);
      base = result.revision;
      revisions.push(result.revision as string);
    }
    const first = await env.service.history(env.user(owner), { taskId: task, limit: 2 });
    expect(first.items.map((item) => item.revision)).toEqual([revisions[4], revisions[3]]);
    expect(first.items.map((item) => item.generation)).toEqual([5, 4]);
    await save("# Plan\n\nstep 6\n", base);
    const second = await env.service.history(env.user(owner), {
      taskId: task,
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((item) => item.revision)).toEqual([revisions[2], revisions[1]]);
    const third = await env.service.history(env.user(owner), {
      taskId: task,
      limit: 2,
      cursor: second.nextCursor as string,
    });
    expect(third.items.map((item) => [item.revision, item.subject])).toEqual([
      [revisions[0], "Created the page"],
    ]);
    expect(third.nextCursor).toBeNull();
    const other = await env.createTask(owner);
    const wrongTask = await failure(
      env.service.history(env.user(owner), { taskId: other, cursor: first.nextCursor as string }),
    );
    expect((wrongTask as DocumentError).code).toBe("document.cursor_invalid");
  });

  it("previews a revision, compares with labeled hunks and pinned pages, and resyncs unknown baselines", async () => {
    const one = await save(portfolio, null);
    const two = await save(
      portfolio.replace("A lighter, quieter portfolio.", "A lighter portfolio."),
      one.revision,
    );
    const three = await save(
      `${portfolio.replace("A lighter, quieter portfolio.", "A lighter portfolio.")}\n## Links\n- Site\n`,
      two.revision,
    );
    const preview = await env.service.getRevision(env.user(owner), task, one.revision as string);
    expect(preview).toMatchObject({
      isHead: false,
      headRevision: three.revision,
      markdown: portfolio,
      entry: { generation: 1, author: "user" },
    });
    const missing = await failure(env.service.getRevision(env.user(owner), task, "e".repeat(40)));
    expect((missing as DocumentError).code).toBe("not_found");

    const compared = await env.service.compare(env.user(owner), {
      taskId: task,
      base: one.revision as string,
    });
    expect(compared).toMatchObject({ targetRevision: three.revision, commitsBetween: 2 });
    expect(compared.changes.map((change) => [change.status, change.heading])).toEqual([
      ["modified", "Overview"],
      ["added", "Links"],
    ]);
    const lines = compared.hunks
      .flatMap((hunk) => hunk.lines)
      .filter((line) => line.kind !== "context");
    expect(lines.map((line) => line.kind)).toContain("removed");
    expect(lines.map((line) => line.kind)).toContain("added");

    const resync = await failure(
      env.service.compare(env.user(owner), { taskId: task, base: "d".repeat(40) }),
    );
    expect((resync as DocumentError).code).toBe("document.resync_required");
    const backwards = await failure(
      env.service.compare(env.user(owner), {
        taskId: task,
        base: three.revision as string,
        target: one.revision as string,
      }),
    );
    expect((backwards as DocumentError).code).toBe("document.resync_required");
  });

  it("restores as a new commit, refuses a stale preview and leaves unchanged content alone", async () => {
    const one = await save("# Plan\n\noriginal\n", null);
    const two = await save("# Plan\n\nchanged\n", one.revision);
    const restored = await env.service.restore(
      env.user(owner),
      { taskId: task, revision: one.revision as string, expectedRevision: two.revision as string },
      { id: "restore-1" },
    );
    if (restored.kind !== "result") throw new Error("replay");
    expect(restored.result).toMatchObject({
      status: "published",
      generation: 3,
      restoredFrom: one.revision,
    });
    expect((await env.service.getHead(env.user(owner), task)).markdown).toBe(
      "# Plan\n\noriginal\n",
    );
    const history = await env.service.history(env.user(owner), { taskId: task });
    expect(history.items.map((item) => item.kind)).toEqual(["restore", "edit", "create"]);

    const stale = await failure(
      env.service.restore(
        env.user(owner),
        {
          taskId: task,
          revision: one.revision as string,
          expectedRevision: two.revision as string,
        },
        { id: "restore-2" },
      ),
    );
    expect((stale as DocumentError).code).toBe("document.conflict");
    const foreign = await failure(
      env.service.restore(
        env.user(owner),
        {
          taskId: task,
          revision: "c".repeat(40),
          expectedRevision: restored.result.revision as string,
        },
        { id: "restore-3" },
      ),
    );
    expect((foreign as DocumentError).code).toBe("not_found");
  });

  it("reviews a conflict section by section and returns only the contested texts", async () => {
    const base = await save("## A\none\n\n## B\ntwo\n\n## C\nthree\n", null);
    await save("## A\nONE by Simon\n\n## B\ntwo\n\n## C\nthree\n", base.revision);
    await env.service.putDraft(env.user(owner), {
      taskId: task,
      baseRevision: base.revision,
      clientSeq: 1,
      markdown: "## A\none typed\n\n## B\ntwo\n\n## C\nTHREE typed\n",
    });
    const review = await env.service.conflict(env.user(owner), {
      taskId: task,
      base: base.revision,
    });
    expect(review.sections.map((section) => [section.heading, section.status])).toEqual([
      ["A", "both_changed"],
      ["B", "unchanged"],
      ["C", "draft_changed"],
    ]);
    expect(review.sections[0]).toMatchObject({
      draftText: "## A\none typed\n\n",
      savedText: "## A\nONE by Simon\n\n",
    });
    expect(review.sections[2]).toMatchObject({ draftText: null, savedText: null });
    expect(review).toMatchObject({
      currentGeneration: 2,
      truncated: false,
      draft: { clientSeq: 1 },
    });
  });
});
