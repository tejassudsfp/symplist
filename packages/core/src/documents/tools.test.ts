import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@symplist/db";
import type { DocumentError } from "@symplist/docs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantRetrievalBudgets, TurnRetrievalBudget } from "./budgets.ts";
import { createDocumentsTestEnvironment, type DocumentsTestEnvironment } from "./test-support.ts";

let env: DocumentsTestEnvironment;
let owner: string;
let task: string;

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  task = await env.createTask(owner);
});

afterEach(async () => {
  await env.close();
});

async function failure(promise: Promise<unknown>): Promise<DocumentError> {
  try {
    await promise;
  } catch (error) {
    return error as DocumentError;
  }
  throw new Error("expected a failure");
}

const portfolio = `Intro line for the page.

## Overview
A lighter, quieter portfolio.

## Projects to feature
- [x] Field notes app
- [ ] Typography experiments

### Photos
Export every image at 1600px.

## Next steps
1. Draft the about page

\`\`\`bash
# not a heading
magick in.png -resize 1600x out.webp
\`\`\`

## Next steps
Second section with a duplicate heading.
`;

async function seed(markdown = portfolio) {
  const result = await env.tools.updateSection(env.simon(owner, task), {
    taskId: task,
    expectedRevision: null,
    placement: "end",
    markdown,
  });
  env.clock += 1_000;
  return result;
}

describe("outline, search and read section (note 06)", () => {
  it("pages the outline with references and sizes only, and marks head-bound cursors stale after an edit", async () => {
    const seeded = await seed();
    const simon = env.simon(owner, task);
    const first = await env.tools.outline(simon, { taskId: task, limit: 3 });
    expect(first.entries.map((entry) => entry.heading)).toEqual([
      null,
      "Overview",
      "Projects to feature",
    ]);
    expect(first).toMatchObject({ revision: seeded.revision, isHead: true, totalSections: 6 });
    expect(JSON.stringify(first)).not.toContain("quieter");
    expect(first.entries[2]?.childCount).toBe(1);

    await env.tools.updateSection(simon, {
      taskId: task,
      expectedRevision: seeded.revision,
      sectionId: first.entries[1]?.sectionId as string,
      placement: "replace",
      markdown: "## Overview\nShorter.",
    });
    const stale = await failure(
      env.tools.outline(simon, { taskId: task, cursor: first.nextCursor as string }),
    );
    expect(stale.code).toBe("document.stale_cursor");
    // A cursor for an explicit revision keeps paging that immutable snapshot.
    const pinned = await env.tools.outline(simon, {
      taskId: task,
      revision: seeded.revision as string,
      limit: 3,
    });
    const rest = await env.tools.outline(simon, {
      taskId: task,
      revision: seeded.revision as string,
      cursor: pinned.nextCursor as string,
    });
    expect(rest.entries.map((entry) => entry.heading)).toEqual([
      "Photos",
      "Next steps",
      "Next steps",
    ]);
    expect(rest).toMatchObject({ isHead: false, nextCursor: null });
  });

  it("returns an empty outline for an empty page and not_found for foreign or scoped-out tasks", async () => {
    expect(await env.tools.outline(env.simon(owner, task), { taskId: task })).toMatchObject({
      revision: null,
      entries: [],
    });
    const intruder = await env.createUser();
    expect(
      (await failure(env.tools.outline(env.simon(intruder, null), { taskId: task }))).code,
    ).toBe("not_found");
    const other = await env.createTask(owner);
    const scoped = env.mcp(owner, { taskIds: [other] });
    expect((await failure(env.tools.outline(scoped, { taskId: task }))).code).toBe("not_found");
  });

  it("searches with bounded snippets and section references", async () => {
    await seed();
    const found = await env.tools.search(env.mcp(owner), { taskId: task, query: "1600X magick" });
    expect(found.matches.map((match) => match.heading)).toEqual(["Next steps"]);
    expect(found.matches[0]?.snippet.length).toBeLessThanOrEqual(244);
    expect(found.retrievedBytes).toBeGreaterThan(0);
  });

  it("reads bounded chunks at an explicit revision, never descendants, with receipts of the delivered range", async () => {
    const seeded = await seed();
    const simon = env.simon(owner, task, { contextEpoch: 2 });
    const outline = await env.tools.outline(simon, { taskId: task });
    const projects = outline.entries.find((entry) => entry.heading === "Projects to feature");
    const budget = new TurnRetrievalBudget(10_000, 0);
    const read = await env.tools.readSection(
      simon,
      {
        taskId: task,
        sectionId: projects?.sectionId as string,
        revision: seeded.revision as string,
        maxBytes: 256,
      },
      { budget },
    );
    expect(read.output.text).toContain("Field notes app");
    expect(read.output.text).not.toContain("1600px");
    expect(read.output.childIds).toHaveLength(1);
    expect(read.output.truncated).toBe(false);
    expect(read.receipt).toMatchObject({
      reader: { kind: "conversation" },
      commitId: seeded.revision,
      rangeStart: 0,
      contextEpoch: 2,
      runId: simon.runId,
    });
    expect(budget.consumedBytes).toBe(read.output.retrievedBytes);

    // A cursor from another section or revision is refused.
    const huge = await env.createTask(owner);
    const big = await env.tools.updateSection(env.simon(owner, huge), {
      taskId: huge,
      expectedRevision: null,
      placement: "end",
      markdown: `# Huge\n\n${"A long paragraph line for pagination.\n\n".repeat(200)}`,
    });
    const hugeOutline = await env.tools.outline(env.simon(owner, huge), { taskId: huge });
    const hugeSection = hugeOutline.entries[0]?.sectionId as string;
    const page = await env.tools.readSection(env.simon(owner, huge), {
      taskId: huge,
      sectionId: hugeSection,
      revision: big.revision as string,
      maxBytes: 512,
    });
    expect(page.output.truncated).toBe(true);
    const wrong = await failure(
      env.tools.readSection(env.simon(owner, huge), {
        taskId: huge,
        sectionId: hugeSection,
        revision: seeded.revision as string,
        cursor: page.output.nextCursor as string,
      }),
    );
    expect(wrong.code).toBe("document.cursor_invalid");

    const unknown = await failure(
      env.tools.readSection(simon, {
        taskId: task,
        sectionId: hugeSection,
        revision: seeded.revision as string,
      }),
    );
    expect(unknown.code).toBe("not_found");
  });

  it("enforces the per-turn budget and per-grant budgets server-side", async () => {
    const seeded = await seed();
    const outline = await env.tools.outline(env.simon(owner, task), { taskId: task });
    const section = outline.entries[1]?.sectionId as string;
    const spent = new TurnRetrievalBudget(1_000, 900);
    const exhausted = await failure(
      env.tools.readSection(
        env.simon(owner, task),
        { taskId: task, sectionId: section, revision: seeded.revision as string },
        { budget: spent },
      ),
    );
    expect(exhausted.code).toBe("document.budget_exhausted");
    const partial = new TurnRetrievalBudget(1_000, 700);
    const read = await env.tools.readSection(
      env.simon(owner, task),
      { taskId: task, sectionId: section, revision: seeded.revision as string, maxBytes: 16_384 },
      { budget: partial },
    );
    expect(read.output.retrievedBytes).toBeLessThanOrEqual(300);
    const grants = new GrantRetrievalBudgets({
      now: () => env.clock,
      capBytes: 300,
      windowMs: 60_000,
    });
    const grantBudget = grants.forGrant("grant-a");
    grantBudget.consume(250);
    expect(grants.forGrant("grant-a").remaining()).toBe(50);
    env.clock += 61_000;
    expect(grants.forGrant("grant-a").remaining()).toBe(300);
  });
});

describe("section updates (§9.2)", () => {
  it("publishes canonical section edits as commits, preserves other sections and refuses stale revisions", async () => {
    const seeded = await seed();
    const before = (await env.service.getHead(env.user(owner), task)).markdown;
    const simon = env.simon(owner, task);
    const outline = await env.tools.outline(simon, { taskId: task });
    const duplicate = outline.entries.filter((entry) => entry.heading === "Next steps")[1];
    const updated = await env.tools.updateSection(simon, {
      taskId: task,
      expectedRevision: seeded.revision,
      sectionId: duplicate?.sectionId as string,
      placement: "replace",
      markdown: "## Next steps\n+ Ship it",
    });
    expect(updated).toMatchObject({ status: "published", generation: 2 });
    expect(updated.changedSectionIds).toHaveLength(1);
    const head = await env.service.getHead(env.user(owner), task);
    expect(head.markdown.startsWith(before.slice(0, before.lastIndexOf("## Next steps")))).toBe(
      true,
    );
    expect(head.markdown.endsWith("## Next steps\n\n* Ship it\n")).toBe(true);
    expect(env.events.at(-1)).toMatchObject({
      author: "simon",
      changedSectionIds: updated.changedSectionIds,
    });

    const stale = await failure(
      env.tools.updateSection(env.simon(owner, task), {
        taskId: task,
        expectedRevision: seeded.revision,
        sectionId: duplicate?.sectionId as string,
        placement: "replace",
        markdown: "## Next steps\nagain",
      }),
    );
    expect(stale.code).toBe("document.conflict");
    expect(stale.details).toMatchObject({ currentRevision: updated.revision });
  });

  it("returns the recorded result for a retried tool call and refuses a different call under the same id", async () => {
    const seeded = await seed();
    const actor = env.simon(owner, task, { toolCallId: "call_retry" });
    const input = {
      taskId: task,
      expectedRevision: seeded.revision,
      placement: "end" as const,
      markdown: "## Added\ntext",
    };
    const first = await env.tools.updateSection(actor, input);
    const retry = await env.tools.updateSection(actor, input);
    expect(retry).toEqual(first);
    const mismatch = await failure(
      env.tools.updateSection(actor, { ...input, markdown: "## Other" }),
    );
    expect(mismatch.code).toBe("idempotency.mismatch");
    expect(await env.count("doc_commits")).toBe(2);
  });

  it("allows edits only from the task's own chat and write-scoped grants", async () => {
    await seed();
    const other = await env.createTask(owner);
    expect(
      (
        await failure(
          env.tools.updateSection(env.simon(owner, other), {
            taskId: task,
            expectedRevision: null,
            placement: "end",
            markdown: "x",
          }),
        )
      ).code,
    ).toBe("document.read_only");
    expect(
      (
        await failure(
          env.tools.updateSection(env.simon(owner, null, { mode: "quick" }), {
            taskId: task,
            expectedRevision: null,
            placement: "end",
            markdown: "x",
          }),
        )
      ).code,
    ).toBe("document.read_only");
    expect(
      (
        await failure(
          env.tools.updateSection(env.mcp(owner, { scopes: ["tasks:read"] }), {
            taskId: task,
            expectedRevision: null,
            placement: "end",
            markdown: "x",
          }),
        )
      ).code,
    ).toBe("document.read_only");
    const quick = env.simon(owner, null, { mode: "quick" });
    expect((await env.tools.outline(quick, { taskId: task })).entries.length).toBeGreaterThan(0);
  });
});

describe("changes, diffs, history and restore (§9.4)", () => {
  it("pins the target across pages, reports nothing for changed-then-reverted content, and resyncs bad baselines", async () => {
    const seeded = await seed("## A\none\n\n## B\ntwo\n\n## C\nthree\n");
    const simon = env.simon(owner, task);
    const outline = await env.tools.outline(simon, { taskId: task });
    const [a, b, c] = outline.entries;
    let head = seeded.revision as string;
    for (const [section, text] of [
      [a, "## A\nONE"],
      [b, "## B\nTWO"],
      [c, "## C\nTHREE"],
    ] as const) {
      const refreshed = await env.tools.outline(env.simon(owner, task), { taskId: task });
      const target = refreshed.entries.find((entry) => entry.heading === section?.heading);
      head = (
        await env.tools.updateSection(env.simon(owner, task), {
          taskId: task,
          expectedRevision: head,
          sectionId: target?.sectionId as string,
          placement: "replace",
          markdown: text,
        })
      ).revision as string;
    }
    const page1 = await env.tools.changes(simon, {
      taskId: task,
      baselineRevision: seeded.revision as string,
      limit: 2,
    });
    expect(page1).toMatchObject({ targetRevision: head, commitsBetween: 3 });
    expect(page1.changes.map((change) => change.heading)).toEqual(["A", "B"]);
    // Another edit lands while paginating; the pinned target keeps the pages consistent.
    const refreshed = await env.tools.outline(env.simon(owner, task), { taskId: task });
    await env.tools.updateSection(env.simon(owner, task), {
      taskId: task,
      expectedRevision: head,
      sectionId: refreshed.entries[0]?.sectionId as string,
      placement: "replace",
      markdown: "## A\none",
    });
    const page2 = await env.tools.changes(simon, {
      taskId: task,
      baselineRevision: seeded.revision as string,
      cursor: page1.nextCursor as string,
    });
    expect(page2).toMatchObject({ targetRevision: head });
    expect(page2.changes.map((change) => change.heading)).toEqual(["C"]);

    // Changed then reverted: net empty, but the intervening commits remain visible.
    const revertTask = await env.createTask(owner);
    const r1 = await env.tools.updateSection(env.simon(owner, revertTask), {
      taskId: revertTask,
      expectedRevision: null,
      placement: "end",
      markdown: "## X\nsame",
    });
    const x1 = await env.tools.outline(env.simon(owner, revertTask), { taskId: revertTask });
    const r2 = await env.tools.updateSection(env.simon(owner, revertTask), {
      taskId: revertTask,
      expectedRevision: r1.revision,
      sectionId: x1.entries[0]?.sectionId as string,
      placement: "replace",
      markdown: "## X\ndifferent",
    });
    const x2 = await env.tools.outline(env.simon(owner, revertTask), { taskId: revertTask });
    const r3 = await env.tools.updateSection(env.simon(owner, revertTask), {
      taskId: revertTask,
      expectedRevision: r2.revision,
      sectionId: x2.entries[0]?.sectionId as string,
      placement: "replace",
      markdown: "## X\nsame",
    });
    const net = await env.tools.changes(env.simon(owner, revertTask), {
      taskId: revertTask,
      baselineRevision: r1.revision as string,
    });
    expect(net).toMatchObject({ targetRevision: r3.revision, commitsBetween: 2, changes: [] });
    const history = await env.tools.history(env.simon(owner, revertTask), { taskId: revertTask });
    expect(history.items).toHaveLength(3);

    for (const baseline of ["d".repeat(40), r1.revision as string]) {
      const error = await failure(
        env.tools.changes(simon, { taskId: task, baselineRevision: baseline }),
      );
      expect(error.code).toBe("document.resync_required");
    }
  });

  it("returns bounded, section-scoped diff hunks and restores through the tool", async () => {
    const seeded = await seed("## A\none\n\n## B\ntwo\n");
    const outline = await env.tools.outline(env.simon(owner, task), { taskId: task });
    const edited = await env.tools.updateSection(env.simon(owner, task), {
      taskId: task,
      expectedRevision: seeded.revision,
      sectionId: outline.entries[1]?.sectionId as string,
      placement: "replace",
      markdown: "## B\nTWO",
    });
    const headOutline = await env.tools.outline(env.simon(owner, task), { taskId: task });
    const budget = new TurnRetrievalBudget(50_000, 0);
    const scoped = await env.tools.diff(
      env.simon(owner, task),
      {
        taskId: task,
        baseRevision: seeded.revision as string,
        sectionIds: [headOutline.entries[1]?.sectionId as string],
      },
      { budget },
    );
    const lines = scoped.hunks.flatMap((hunk) => hunk.lines);
    expect(
      lines.filter((line) => line.kind !== "context").map((line) => [line.kind, line.text]),
    ).toEqual([
      ["removed", "two"],
      ["added", "TWO"],
    ]);
    expect(budget.consumedBytes).toBe(scoped.retrievedBytes);
    const unrelated = await env.tools.diff(env.simon(owner, task), {
      taskId: task,
      baseRevision: seeded.revision as string,
      sectionIds: [headOutline.entries[0]?.sectionId as string],
    });
    expect(unrelated.hunks).toEqual([]);

    const restored = await env.tools.restore(env.mcp(owner), {
      taskId: task,
      revision: seeded.revision as string,
      expectedRevision: edited.revision as string,
    });
    expect(restored).toMatchObject({
      status: "published",
      restoredFrom: seeded.revision,
      generation: 3,
    });
    const history = await env.tools.history(env.mcp(owner), { taskId: task, limit: 1 });
    expect(history.items[0]).toMatchObject({ kind: "restore", author: "mcp" });
    expect(history.nextCursor).not.toBeNull();
  });
});

describe("read positions (§9.4)", () => {
  it("reports read, changed, unread and previously read sections from checkpointed receipts", async () => {
    const seeded = await seed("## A\none\n\n## B\ntwo\n\n## C\nthree\n");
    const simon = env.simon(owner, task, { contextEpoch: 1 });
    const outline = await env.tools.outline(simon, { taskId: task });
    const receipts = [];
    for (const entry of outline.entries.slice(0, 2)) {
      const read = await env.tools.readSection(simon, {
        taskId: task,
        sectionId: entry.sectionId,
        revision: seeded.revision as string,
      });
      if (read.receipt) receipts.push(read.receipt);
    }
    // Receipts are written by the checkpoint, never by the tool itself.
    expect(await env.count("read_receipts")).toBe(0);
    await env.db.batch(env.tools.receiptStatements(receipts));
    expect(await env.count("read_receipts")).toBe(2);
    await env.tools.updateSection(env.simon(owner, task), {
      taskId: task,
      expectedRevision: seeded.revision,
      sectionId: outline.entries[1]?.sectionId as string,
      placement: "replace",
      markdown: "## B\nchanged",
    });
    const positions = await env.tools.readPositions(simon, task);
    expect(positions.sections.map((section) => [section.heading, section.state])).toEqual([
      ["A", "read"],
      ["B", "changed_since_read"],
      ["C", "unread"],
    ]);
    const compacted = await env.tools.readPositions(
      env.simon(owner, task, { contextEpoch: 2 }),
      task,
    );
    expect(compacted.sections.map((section) => section.state)).toEqual([
      "previously_read",
      "previously_read",
      "unread",
    ]);
    // MCP grants have their own receipts.
    const grant = await env.tools.readPositions(env.mcp(owner), task);
    expect(grant.sections.every((section) => section.state === "unread")).toBe(true);
  });
});

describe("no model calls and no plaintext leakage (note 11)", () => {
  it("never imports a model provider from the document code", () => {
    const roots = [
      fileURLToPath(new URL(".", import.meta.url)),
      fileURLToPath(new URL("../../../docs/src", import.meta.url)),
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const source = readFileSync(path, "utf8");
          if (
            /from\s+["'](?:ai|@ai-sdk\/[^"']+|@symplist\/agent|@symplist\/integrations|@composio\/core)["']/.test(
              source,
            )
          ) {
            offenders.push(path);
          }
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });

  it("makes no network requests while saving, reading and diffing, and stores no plaintext in D1", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const marker = "MARKER-7f3a document secret";
    const seeded = await seed(`## Secret\n${marker}\n`);
    const outline = await env.tools.outline(env.simon(owner, task), { taskId: task });
    await env.tools.readSection(env.simon(owner, task), {
      taskId: task,
      sectionId: outline.entries[0]?.sectionId as string,
      revision: seeded.revision as string,
    });
    await env.tools.updateSection(env.simon(owner, task), {
      taskId: task,
      expectedRevision: seeded.revision,
      placement: "end",
      markdown: `## More\n${marker}`,
    });
    await env.tools.diff(env.simon(owner, task), {
      taskId: task,
      baseRevision: seeded.revision as string,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const tables = await env.db.all<{ name: string }>(
      sql(`SELECT name FROM sqlite_master WHERE type = 'table'`),
    );
    for (const { name } of tables) {
      if (!/^[a-z0-9_]+$/.test(name)) continue;
      const rows = JSON.stringify(await env.db.all(sql(`SELECT * FROM "${name}"`)));
      expect(rows, name).not.toContain("MARKER-7f3a");
    }
    expect(await env.git.tempRoot.list()).toEqual([]);
  });
});
