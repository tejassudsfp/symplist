import { mayaTask } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import {
  documentFor,
  extraTask,
  mayaIndex,
  newTaskId,
  ownerId,
  request,
  taskRecord,
} from "./fixtures.test-support.ts";
import { parseQuery } from "./query.ts";
import { classifyTitle, runSearch } from "./rank.ts";
import { SearchIndex } from "./search-index.ts";
import { SearchView } from "./view.ts";

function titlesOf(run: ReturnType<typeof runSearch>): string[] {
  return run.groups.map((group) => group.task.title);
}

function search(view: SearchView, text: string, overrides: Parameters<typeof request>[0] = {}) {
  return runSearch(view, parseQuery(text), request(overrides));
}

describe("relevance fixtures (note 14)", () => {
  const view = SearchView.of(mayaIndex({ includeChat: true }));

  it("ranks an exact title first, ahead of documents that mention the words", () => {
    const run = search(view, "Send the project outline");
    expect(run.groups[0]?.task.title).toBe("Send the project outline");
    expect(run.groups[0]?.match).toBe("title_exact");
  });

  it("ranks title prefixes above titles that only contain the term", () => {
    const run = search(view, "notes");
    expect(run.groups[0]?.task.title).toBe("Notes from the weekend");
    expect(run.groups[0]?.match).toBe("title_prefix");
    const kinds = run.groups.map((group) => group.match);
    expect(kinds.indexOf("heading")).toBeGreaterThan(0);
    expect(kinds.indexOf("body")).toBeGreaterThan(kinds.indexOf("heading"));
  });

  it("matches partial words as the user types", () => {
    expect(titlesOf(search(view, "bo"))).toEqual(["Book a bike tune-up"]);
    expect(search(view, "bo", { archive: "include" }).groups.map((group) => group.match)).toEqual([
      "title_prefix",
      "title_prefix",
    ]);
    expect(titlesOf(search(view, "pott"))).toEqual(["Try the pottery class"]);
  });

  it("tolerates a bounded typo in task titles only", () => {
    const run = search(view, "potery");
    expect(titlesOf(run)).toEqual(["Try the pottery class"]);
    expect(run.groups[0]?.match).toBe("title_typo");
    // Too short for a typo: `book` never matches `look`.
    expect(titlesOf(search(view, "book"))).toEqual(["Book a bike tune-up"]);
    // Body text never matches typos.
    expect(search(view, "bakry").groups).toEqual([]);
  });

  it("ranks exact title terms above typo matches", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    index.upsertTask(extraTask(1, "Garden plan"));
    index.upsertTask(extraTask(2, "Gardn notes", { updatedAt: 1_789_999_999_999 }));
    const run = search(SearchView.of(index), "garden");
    expect(run.groups.map((group) => [group.task.title, group.match])).toEqual([
      ["Garden plan", "title_prefix"],
      ["Gardn notes", "title_typo"],
    ]);
  });

  it("requires every term of a multiword query, in any field of the section", () => {
    const run = search(view, "garden outline budget");
    expect(titlesOf(run)).toEqual(["Send the project outline"]);
    expect(run.groups[0]?.matchedAllTerms).toBe(true);
    expect(run.partialTerms).toBe(false);
  });

  it("prefers contiguous phrases for unquoted multiword queries", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const apart = extraTask(1, "Apart", { updatedAt: 2_000_000_000_000 });
    const together = extraTask(2, "Together", { updatedAt: 1_000_000_000_000 });
    index.upsertTask(apart);
    index.upsertTask(together);
    index.replaceDocument(
      documentFor(apart.id, "## Notes\nThe garden needs a community of helpers."),
    );
    index.replaceDocument(
      documentFor(together.id, "## Notes\nThe community garden needs helpers."),
    );
    const run = search(SearchView.of(index), "community garden");
    expect(titlesOf(run)).toEqual(["Together", "Apart"]);
    expect(run.groups[0]?.sections[0]?.phrase).toBe(true);
    expect(run.groups[1]?.sections[0]?.phrase).toBe(false);
  });

  it("filters by quoted phrases", () => {
    const run = search(view, '"community garden"');
    expect(new Set(titlesOf(run))).toEqual(
      new Set(["Send the project outline", "Review the outline"]),
    );
    expect(search(view, '"garden community"').groups).toEqual([]);
  });

  it("falls back to partial-term results only when nothing matches every term", () => {
    const run = search(view, "pottery spreadsheet");
    expect(run.partialTerms).toBe(true);
    expect(new Set(titlesOf(run))).toEqual(
      new Set(["Try the pottery class", "Look into a standing desk"]),
    );
    expect(run.groups.every((group) => !group.matchedAllTerms)).toBe(true);
    expect(search(view, '"pottery spreadsheet"').groups).toEqual([]);
  });

  it("keeps duplicate titles apart, most recently updated first, with a stable order", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const older = extraTask(1, "Weekly review", { updatedAt: 1_000, parentId: null });
    const newer = extraTask(2, "Weekly review", { updatedAt: 2_000, collection: "later" });
    const sameTime = extraTask(3, "Weekly review", { updatedAt: 2_000 });
    for (const task of [older, sameTime, newer]) index.upsertTask(task);
    const run = search(SearchView.of(index), "weekly review");
    expect(run.groups.map((group) => group.task.id)).toEqual([newer.id, sameTime.id, older.id]);
    expect(run.groups.every((group) => group.match === "title_exact")).toBe(true);
    expect(
      search(SearchView.of(index), "weekly review").groups.map((group) => group.task.id),
    ).toEqual(run.groups.map((group) => group.task.id));
  });

  it("does not let recency bury a clearly better match", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const precise = extraTask(1, "Notes", { updatedAt: 1_000 });
    const recent = extraTask(2, "Old notes about the kitchen renovation and paint colours", {
      updatedAt: 9_000,
    });
    index.upsertTask(precise);
    index.upsertTask(recent);
    expect(titlesOf(search(SearchView.of(index), "notes"))).toEqual([precise.title, recent.title]);
  });

  it("ranks heading matches above body matches", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const inBody = extraTask(1, "First", { updatedAt: 9_000 });
    const inHeading = extraTask(2, "Second", { updatedAt: 1_000 });
    index.upsertTask(inBody);
    index.upsertTask(inHeading);
    index.replaceDocument(documentFor(inBody.id, "## Plan\nWe discussed the budget at length."));
    index.replaceDocument(documentFor(inHeading.id, "## Budget\nNumbers go here."));
    const run = search(SearchView.of(index), "budget");
    expect(run.groups.map((group) => [group.task.title, group.match])).toEqual([
      ["Second", "heading"],
      ["First", "body"],
    ]);
  });

  it("matches Unicode text regardless of case, accents, width, ligatures and script", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const cases: [string, string, string][] = [
      ["CAFÉ ORDER", "## Menu\nÉCLAIRS and café crème", "cafe"],
      ["Straße repairs", "## Street\nNotes", "strasse"],
      ["İstanbul trip", "## Plan\nFlights", "istanbul"],
      ["ＦＵＬＬ width", "## Wide\nText", "full"],
      ["Travel", "## ﬁle\nThe ﬁnal ﬁgures", "final"],
      ["旅行", "## 予定\n東京に行きます", "行きます"],
      ["Diwali", "## योजना\nमिठाई खरीदें", "मिठाई"],
    ];
    cases.forEach(([title, markdown], position) => {
      const task = extraTask(position + 1, title);
      index.upsertTask(task);
      index.replaceDocument(documentFor(task.id, markdown));
    });
    const unicodeView = SearchView.of(index);
    cases.forEach(([title, , query]) => {
      expect(titlesOf(search(unicodeView, query))).toContain(title);
    });
    expect(titlesOf(search(unicodeView, "résumé ÉCLAIRS"))).toEqual(["CAFÉ ORDER"]);
    expect(titlesOf(search(unicodeView, "東京"))).toEqual(["旅行"]);
  });

  it("finds matches deep inside long documents and snippets the right chunk", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const task = extraTask(1, "Research log");
    index.upsertTask(task);
    const filler = Array.from({ length: 3_000 }, (_, i) => `entry${i % 97} observation`).join(" ");
    const markdown = `## Log\n${filler} the rare kingfisher appeared near the pond ${filler}`;
    index.replaceDocument(documentFor(task.id, markdown));
    expect(index.stats().sectionEntryCount).toBeGreaterThan(40);
    const run = search(SearchView.of(index), "kingfisher pond");
    expect(run.groups).toHaveLength(1);
    const hit = run.groups[0]?.sections[0];
    expect(hit?.entry.text).toContain("kingfisher");
    expect(hit?.entry.start).toBeGreaterThan(10_000);
    expect(run.groups[0]?.sections).toHaveLength(1);
  });

  it("excludes archived tasks by default and marks them when included", () => {
    expect(titlesOf(search(view, "pottery"))).toEqual(["Try the pottery class"]);
    const included = search(view, "pottery", { archive: "include" });
    expect(new Set(titlesOf(included))).toEqual(
      new Set(["Try the pottery class", "Book the pottery class"]),
    );
    expect(included.groups.find((group) => group.task.archived)?.task.title).toBe(
      "Book the pottery class",
    );
    expect(titlesOf(search(view, "pottery", { archive: "only" }))).toEqual([
      "Book the pottery class",
    ]);
  });

  it("groups several section matches under one task", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const task = extraTask(1, "Trip");
    index.upsertTask(task);
    index.replaceDocument(
      documentFor(
        task.id,
        "## Packing\nBring the camera.\n## Camera settings\nISO 200\n## Day two\nCharge the camera.",
      ),
    );
    const run = search(SearchView.of(index), "camera");
    expect(run.groups).toHaveLength(1);
    const group = run.groups[0];
    expect(group?.match).toBe("heading");
    expect(group?.sections.map((hit) => [hit.entry.heading, hit.match])).toEqual([
      ["Camera settings", "heading"],
      ["Packing", "body"],
      ["Day two", "body"],
    ]);
  });

  it("applies collection, content type and task filters before ranking", () => {
    expect(titlesOf(search(view, "outline", { collections: new Set(["unclassified"]) }))).toEqual([
      "Review the outline",
    ]);
    const titlesOnly = search(view, "outline", { types: new Set(["tasks"]) });
    expect(titlesOnly.groups.every((group) => group.sections.length === 0)).toBe(true);
    const documentsOnly = search(view, "outline", { types: new Set(["documents"]) });
    expect(documentsOnly.groups.every((group) => group.titleMatch === null)).toBe(true);
    const scoped = search(view, "outline", {
      taskIds: new Set([mayaTask("Review the outline").id]),
    });
    expect(titlesOf(scoped)).toEqual(["Review the outline"]);
  });

  it("searches chat only when requested and permitted, as a separate content type", () => {
    const withoutPermission = search(view, "missing images", {
      types: new Set(["tasks", "documents", "chat"]),
    });
    expect(withoutPermission.groups.every((group) => group.messages.length === 0)).toBe(true);
    const onlyChatWithoutPermission = search(view, "missing images", { types: new Set(["chat"]) });
    expect(onlyChatWithoutPermission.groups).toEqual([]);
    const run = search(view, "project image", {
      types: new Set(["chat"]),
      chat: true,
    });
    expect(titlesOf(run)).toEqual(["Refresh my portfolio"]);
    expect(run.groups[0]?.match).toBe("chat");
    expect(run.groups[0]?.messages.map((hit) => hit.message.speaker)).toEqual(["user", "simon"]);
  });

  it("is deterministic across identical runs", () => {
    const first = search(view, "the", { archive: "include" });
    const second = search(view, "the", { archive: "include" });
    expect(second.groups.map((group) => group.task.id)).toEqual(
      first.groups.map((group) => group.task.id),
    );
  });

  it("caps evaluated groups and reports it", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    for (let i = 0; i < 30; i += 1) index.upsertTask(extraTask(i + 1, `Shared word ${i}`));
    const run = runSearch(
      SearchView.of(index),
      parseQuery("shared"),
      request({ limits: { maxGroups: 10 } }),
    );
    expect(run.groups).toHaveLength(10);
    expect(run.capped).toBe(true);
  });

  it("returns nothing for queries without searchable words", () => {
    expect(search(view, "👍").groups).toEqual([]);
  });
});

describe("classifyTitle", () => {
  const check = (query: string, title: string) => classifyTitle(parseQuery(query), title)?.match;

  it("classifies exact, prefix, terms and typo matches", () => {
    expect(check("book a bike tune-up", "Book a bike tune-up")).toBe("title_exact");
    expect(check("book a b", "Book a bike tune-up")).toBe("title_prefix");
    expect(check("bike book", "Book a bike tune-up")).toBe("title_terms");
    expect(check("bicycle", "Book a bike tune-up")).toBeUndefined();
    expect(check("tuneup", "Book a bike tune-up")).toBeUndefined();
    expect(check("pottery clas", "Try the pottery class")).toBe("title_terms");
    expect(check("potery", "Try the pottery class")).toBe("title_typo");
  });

  it("respects quoted phrases in titles", () => {
    expect(check('"pottery class"', "Try the pottery class")).toBe("title_terms");
    expect(check('"class pottery"', "Try the pottery class")).toBeUndefined();
  });

  it("uses the Maya fixture titles", () => {
    expect(check("refresh", taskRecord(mayaTask("Refresh my portfolio")).title)).toBe(
      "title_prefix",
    );
    expect(newTaskId(1)).not.toBe(newTaskId(2));
  });
});
