import { randomBytes } from "node:crypto";
import { createAccountKey, createKeyProvider, keyFamilies } from "@symplist/crypto";
import { mayaTask } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import {
  openSearchIndex,
  parseSearchIndexObjectKey,
  SEARCH_INDEX_OBJECT_KIND,
  sealSearchIndex,
  searchIndexObjectKey,
  searchIndexObjectPrefix,
} from "./envelope.ts";
import {
  documentFor,
  extraTask,
  mayaIndex,
  newTaskId,
  ownerId,
  request,
  taskRecord,
} from "./fixtures.test-support.ts";
import { INDEX_FORMAT_VERSION, TOKENIZER_FINGERPRINT } from "./normalize.ts";
import { parseQuery } from "./query.ts";
import { runSearch } from "./rank.ts";
import { SearchRecordError } from "./records.ts";
import { SearchIndex, SearchIndexFormatError } from "./search-index.ts";
import { SearchOverlayBuilder, SearchView } from "./view.ts";

const writeId = "0192f0a0-1111-7000-8000-000000000001";
const otherOwner = "0192f0a0-0000-7000-8000-0000000000ff";

function keys() {
  return createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      ]),
    ),
  );
}

function titles(view: SearchView, text: string) {
  return runSearch(view, parseQuery(text), request({ archive: "include" })).groups.map(
    (group) => group.task.title,
  );
}

describe("SearchIndex mutations", () => {
  it("replaces a task title and removes the old terms", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const task = extraTask(1, "Draft invoice");
    index.upsertTask(task);
    index.upsertTask({ ...task, title: "Send receipt", version: 2 });
    const view = SearchView.of(index);
    expect(titles(view, "invoice")).toEqual([]);
    expect(titles(view, "receipt")).toEqual(["Send receipt"]);
    expect(index.stats().taskCount).toBe(1);
  });

  it("replaces a document with a new revision and drops removed sections", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const task = extraTask(1, "Trip");
    index.upsertTask(task);
    index.replaceDocument(documentFor(task.id, "## Hotel\nBook the lakeside inn", "rev1"));
    index.replaceDocument(documentFor(task.id, "## Train\nReserve seats", "rev2"));
    const view = SearchView.of(index);
    expect(titles(view, "lakeside")).toEqual([]);
    expect(titles(view, "seats")).toEqual(["Trip"]);
    expect(index.documentRevision(task.id)).toBe("rev2");
  });

  it("removes a task with its document and messages", () => {
    const index = SearchIndex.create({ ownerId, includeChat: true });
    const task = extraTask(1, "Trip");
    index.upsertTask(task);
    index.replaceDocument(documentFor(task.id, "## Hotel\nlakeside"));
    index.upsertMessage({
      id: newTaskId(50),
      taskId: task.id,
      conversationId: newTaskId(51),
      speaker: "user",
      createdAt: 1,
      text: "lakeside please",
    });
    index.removeTask(task.id);
    expect(index.stats()).toMatchObject({
      taskCount: 0,
      documentCount: 0,
      messageCount: 0,
      textChars: 0,
    });
  });

  it("never indexes chat messages when chat is not opted in", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    index.upsertMessage({
      id: newTaskId(50),
      taskId: newTaskId(1),
      conversationId: newTaskId(51),
      speaker: "simon",
      createdAt: 1,
      text: "secret words",
    });
    expect(index.stats().messageCount).toBe(0);
  });

  it("validates records before changing anything", () => {
    const index = SearchIndex.create({ ownerId, includeChat: false });
    expect(() => index.upsertTask({ ...extraTask(1, "x"), id: "task-1" })).toThrow(
      SearchRecordError,
    );
    expect(() =>
      index.replaceDocument({
        taskId: newTaskId(1),
        revision: "rev 1",
        sections: [],
      }),
    ).toThrow(SearchRecordError);
    expect(() =>
      index.replaceDocument({
        taskId: newTaskId(1),
        revision: "rev1",
        sections: [
          { sectionId: "a", ordinal: 0, heading: null, text: "" },
          { sectionId: "b", ordinal: 0, heading: null, text: "" },
        ],
      }),
    ).toThrow(SearchRecordError);
    expect(index.stats().taskCount).toBe(0);
  });

  it("enforces the document and corpus size limits and reports truncation", () => {
    const index = SearchIndex.create({
      ownerId,
      includeChat: true,
      limits: {
        maxDocumentChars: 500,
        maxCorpusChars: 900,
        chunkChars: 100,
        chunkOverlapChars: 10,
      },
    });
    const first = extraTask(1, "First");
    const second = extraTask(2, "Second");
    index.upsertTask(first);
    index.upsertTask(second);
    index.replaceDocument(documentFor(first.id, `## A\n${"alpha ".repeat(200)}tailword`));
    expect(index.truncated).toBe(true);
    expect(titles(SearchView.of(index), "tailword")).toEqual([]);
    index.replaceDocument(documentFor(second.id, `## B\n${"beta ".repeat(200)}`));
    expect(index.stats().textChars).toBeLessThanOrEqual(900);
    index.upsertMessage({
      id: newTaskId(60),
      taskId: second.id,
      conversationId: newTaskId(61),
      speaker: "user",
      createdAt: 1,
      text: "late message",
    });
    expect(index.stats().messageCount).toBe(0);
    expect(index.truncated).toBe(true);
  });

  it("caps sections per document", () => {
    const index = SearchIndex.create({
      ownerId,
      includeChat: false,
      limits: { maxSectionsPerDocument: 2 },
    });
    const task = extraTask(1, "Many");
    index.upsertTask(task);
    index.replaceDocument(documentFor(task.id, "## One\nx\n## Two\ny\n## Three\nlastsection"));
    expect(index.truncated).toBe(true);
    expect(titles(SearchView.of(index), "lastsection")).toEqual([]);
  });
});

describe("serialization", () => {
  it("round-trips an index through its artifact after compaction", async () => {
    const index = mayaIndex({ includeChat: true });
    index.upsertTask(
      taskRecord(mayaTask("Plan a quiet weekend"), { title: "Plan a raucous weekend" }),
    );
    index.removeDocument(mayaTask("Try the pottery class").id);
    await index.compact();
    const artifact = JSON.parse(
      JSON.stringify(index.toArtifact({ generation: 3, appliedThrough: 42 })),
    );
    expect(artifact).toMatchObject({
      indexFormatVersion: INDEX_FORMAT_VERSION,
      tokenizerFingerprint: TOKENIZER_FINGERPRINT,
      generation: 3,
      appliedThrough: 42,
      includeChat: true,
    });
    const restored = SearchIndex.fromArtifact(artifact, { ownerId, generation: 3 });
    expect(restored.stats()).toEqual(index.stats());
    const before = SearchView.of(index);
    const after = SearchView.of(restored);
    for (const query of ["raucous", "quiet", "outline", "wheel", '"community garden"', "images"]) {
      expect(titles(after, query)).toEqual(titles(before, query));
    }
  });

  it("refuses to serialize before compaction", () => {
    const index = mayaIndex();
    index.removeTask(mayaTask("Try the pottery class").id);
    expect(() => index.toArtifact({ generation: 1, appliedThrough: 0 })).toThrow(/Compact/);
  });

  it("rejects artifacts from another format, tokenizer, owner or generation, or inconsistent ones", async () => {
    const index = mayaIndex();
    await index.compact();
    const artifact = JSON.parse(
      JSON.stringify(index.toArtifact({ generation: 2, appliedThrough: 0 })),
    );
    const expected = { ownerId, generation: 2 };
    const reason = (value: unknown, meta = expected) => {
      try {
        SearchIndex.fromArtifact(value, meta);
        return "loaded";
      } catch (error) {
        return (error as SearchIndexFormatError).reason;
      }
    };
    expect(reason(artifact)).toBe("loaded");
    expect(reason({ ...artifact, indexFormatVersion: 99 })).toBe("format_version");
    expect(reason({ ...artifact, tokenizerFingerprint: "old" })).toBe("fingerprint");
    expect(reason(artifact, { ownerId: otherOwner, generation: 2 })).toBe("owner");
    expect(reason(artifact, { ownerId, generation: 3 })).toBe("generation");
    expect(reason({ ...artifact, tasks: artifact.tasks.slice(1) })).toBe("malformed");
    expect(reason({ ...artifact, miniSearch: { nonsense: true } })).toBe("malformed");
    expect(reason(null)).toBe("malformed");
  });
});

describe("encrypted index objects (§4.1, §10.1)", () => {
  const provider = keys();
  const { key } = createAccountKey(provider, ownerId);

  it("names immutable, owner-prefixed keys and parses them back", () => {
    expect(searchIndexObjectPrefix(ownerId)).toBe(`u/${ownerId}/search/`);
    const objectKey = searchIndexObjectKey(ownerId, 7, writeId);
    expect(objectKey).toBe(`u/${ownerId}/search/7-${writeId}.idx`);
    expect(parseSearchIndexObjectKey(ownerId, objectKey)).toEqual({ generation: 7, writeId });
    expect(parseSearchIndexObjectKey(otherOwner, objectKey)).toBeNull();
    expect(parseSearchIndexObjectKey(ownerId, `u/${ownerId}/search/x.idx`)).toBeNull();
    expect(() => searchIndexObjectKey(ownerId, 0, writeId)).toThrow(TypeError);
    expect(SEARCH_INDEX_OBJECT_KIND).toBe("search_index");
  });

  it("seals with SYMO envelopes and opens only with the same owner, generation and write id", async () => {
    const index = mayaIndex({ includeChat: true });
    const sealed = await sealSearchIndex(key, index, { generation: 4, appliedThrough: 9, writeId });
    expect(Buffer.from(sealed.body.subarray(0, 4)).toString("latin1")).toBe("SYMO");
    expect(Buffer.from(sealed.body).toString("latin1")).not.toContain("pottery");
    const opened = openSearchIndex(key, sealed.body, { ownerId, generation: 4, writeId });
    expect(opened.appliedThrough).toBe(9);
    expect(opened.plaintextBytes).toBe(sealed.plaintextBytes);
    expect(titles(SearchView.of(opened.index), "pottery")).toEqual(
      titles(SearchView.of(index), "pottery"),
    );

    const failure = (fn: () => unknown) => {
      try {
        fn();
        return "opened";
      } catch (error) {
        return error instanceof SearchIndexFormatError ? error.reason : "other";
      }
    };
    const otherWrite = "0192f0a0-1111-7000-8000-000000000002";
    expect(
      failure(() => openSearchIndex(key, sealed.body, { ownerId, generation: 5, writeId })),
    ).toBe("decryption");
    expect(
      failure(() =>
        openSearchIndex(key, sealed.body, { ownerId, generation: 4, writeId: otherWrite }),
      ),
    ).toBe("decryption");
    const other = createAccountKey(provider, otherOwner).key;
    expect(
      failure(() =>
        openSearchIndex(other, sealed.body, { ownerId: otherOwner, generation: 4, writeId }),
      ),
    ).toBe("decryption");
    const tampered = sealed.body.slice();
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] as number) ^ 1;
    expect(failure(() => openSearchIndex(key, tampered, { ownerId, generation: 4, writeId }))).toBe(
      "decryption",
    );
    expect(
      failure(() =>
        openSearchIndex(key, sealed.body.subarray(0, sealed.body.length - 100), {
          ownerId,
          generation: 4,
          writeId,
        }),
      ),
    ).toBe("decryption");
    expect(
      failure(() =>
        openSearchIndex(key, new Uint8Array([1, 2, 3]), { ownerId, generation: 4, writeId }),
      ),
    ).toBe("malformed");
  });

  it("detects an index written in another format version without decrypting it", async () => {
    const sealed = await sealSearchIndex(key, mayaIndex(), {
      generation: 1,
      appliedThrough: 0,
      writeId,
    });
    const header = Buffer.from(sealed.body);
    const length = header.readUInt32BE(5);
    const json = header
      .subarray(9, 9 + length)
      .toString("utf8")
      .replace('"v":1', '"v":2');
    const rewritten = Buffer.concat([
      header.subarray(0, 9),
      Buffer.from(json),
      header.subarray(9 + length),
    ]);
    expect(() => openSearchIndex(key, rewritten, { ownerId, generation: 1, writeId })).toThrow(
      expect.objectContaining({ reason: "format_version" }),
    );
  });

  it("refuses to seal with another owner's key", async () => {
    const other = createAccountKey(provider, otherOwner).key;
    await expect(
      sealSearchIndex(other, mayaIndex(), { generation: 1, appliedThrough: 0, writeId }),
    ).rejects.toThrow(TypeError);
  });
});

describe("overlay views (§10.1 unindexed intents in memory)", () => {
  it("shadows renamed, removed and re-documented tasks without touching the base index", () => {
    const base = mayaIndex({ includeChat: true });
    const builder = new SearchOverlayBuilder(base, { ownerId, includeChat: true });
    const renamed = mayaTask("Plan a quiet weekend");
    builder.upsertTask(taskRecord(renamed, { title: "Plan a raucous weekend", version: 2 }));
    builder.removeTask(mayaTask("Try the pottery class").id);
    builder.replaceDocument(
      documentFor(
        mayaTask("Send the project outline").id,
        "## Outline\nNow about orchards",
        "rev2",
      ),
    );
    const added = extraTask(1, "Brand new errand");
    builder.upsertTask(added);
    const view = builder.view();

    expect(titles(view, "raucous")).toEqual(["Plan a raucous weekend"]);
    expect(titles(view, "quiet")).not.toContain("Plan a quiet weekend");
    expect(titles(view, "wheel")).not.toContain("Try the pottery class");
    expect(titles(view, "garden budget")).not.toContain("Send the project outline");
    expect(titles(view, "orchards")).toEqual(["Send the project outline"]);
    expect(titles(view, "brand")).toEqual(["Brand new errand"]);
    expect(view.task(mayaTask("Try the pottery class").id)).toBeUndefined();
    // The base index is untouched.
    expect(titles(SearchView.of(base), "quiet")).toContain("Plan a quiet weekend");
  });

  it("hides messages of removed tasks and replaced messages", () => {
    const base = mayaIndex({ includeChat: true });
    const builder = new SearchOverlayBuilder(base, { ownerId, includeChat: true });
    builder.removeTask(mayaTask("Refresh my portfolio").id);
    const view = builder.view();
    const run = runSearch(
      view,
      parseQuery("project image"),
      request({ types: new Set(["chat"]), chat: true }),
    );
    expect(run.groups).toEqual([]);
  });

  it("serves title results with no published index while rebuilding", () => {
    const builder = new SearchOverlayBuilder(null, { ownerId, includeChat: false });
    builder.upsertTask(extraTask(1, "Only titles while rebuilding"));
    expect(titles(builder.view(), "rebuilding")).toEqual(["Only titles while rebuilding"]);
  });

  it("refuses an overlay for another owner's index", () => {
    expect(
      () => new SearchOverlayBuilder(mayaIndex(), { ownerId: otherOwner, includeChat: false }),
    ).toThrow();
  });
});
