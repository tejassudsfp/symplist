import {
  type DocumentDraft,
  type DocumentHeadChangedEvent,
  documentHeadChangedEventSchema,
} from "@symplist/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiNetworkError } from "@/lib/api";
import { canonicalFixture, FakeDocuments } from "./fake-api.ts";
import type { DocumentHeadListener, watchDocumentHead } from "./realtime.ts";
import { SAVE_IDLE_MS, type SchedulerTimers } from "./save-scheduler.ts";
import {
  canonicalOrNull,
  type DocumentState,
  describeHeadChange,
  documentReducer,
  type HeadSnapshot,
  useDocument,
} from "./use-document.ts";

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
const sectionId = `s${"a".repeat(25)}`;

const page = [
  "## Overview",
  "",
  "Three projects, one page.",
  "",
  "## Next steps",
  "",
  "* Pick three projects",
  "",
].join("\n");

/** A clock and timer queue the test advances by hand. */
class FakeTimers implements SchedulerTimers {
  time = 1_758_000_000_000;
  private next = 1;
  private readonly pending = new Map<number, { at: number; run: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { at: this.time + ms, run: callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.pending.delete(handle);
      this.time = timer.at;
      timer.run();
    }
    this.time = target;
  }
}

/** A `watchDocumentHead` the test drives, standing in for the app-wide socket. */
function fakeWatch() {
  const listeners = new Set<DocumentHeadListener>();
  const watch: typeof watchDocumentHead = (_taskId, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    watch,
    get size() {
      return listeners.size;
    },
    headChanged(event: DocumentHeadChangedEvent) {
      for (const listener of listeners) listener.onHeadChanged(event);
    },
    snapshotHead(revision: string) {
      for (const listener of listeners) listener.onSnapshotHead?.(taskId, revision);
    },
    resync() {
      for (const listener of listeners) listener.onResync?.();
    },
  };
}

/** A `document.head_changed` frame as the contracts define it. */
function headEvent(
  revision: string,
  author: "user" | "simon" | "mcp",
  changedSectionIds: string[] = [],
): DocumentHeadChangedEvent {
  return documentHeadChangedEventSchema.parse({ taskId, revision, author, changedSectionIds });
}

let timers: FakeTimers;
let socket: ReturnType<typeof fakeWatch>;

function mount(fake: FakeDocuments, view: "page" | "raw" = "page") {
  return renderHook(
    (props: { view: "page" | "raw" }) =>
      useDocument({ taskId, api: fake.api, timers, watch: socket.watch, view: props.view }),
    { initialProps: { view } },
  );
}

async function ready(result: { current: { state: DocumentState } }) {
  await waitFor(() => expect(result.current.state.phase).toBe("ready"));
}

function apiError(status: number, code: string, details?: Record<string, unknown>): ApiError {
  return new ApiError({
    status,
    code,
    message: "internal",
    requestId: "r",
    ...(details ? { details } : {}),
  });
}

beforeEach(() => {
  timers = new FakeTimers();
  socket = fakeWatch();
});

describe("documentReducer", () => {
  const head: HeadSnapshot = {
    revision: "a".repeat(40),
    generation: 1,
    markdown: page,
    author: "user",
    updatedAt: 10,
    canonical: true,
    hasRawHtml: false,
    parseMode: "parsed",
    sections: [],
  };
  const base: DocumentState = {
    phase: "ready",
    failure: null,
    head,
    buffer: page,
    baseRevision: head.revision,
    dirty: false,
    save: { kind: "saved", at: 10 },
    conflict: null,
    agentUpdate: null,
    readOnly: null,
    draftSeq: 0,
    normalizationPending: false,
  };

  it("returns the same state when the buffer did not change", () => {
    expect(documentReducer(base, { type: "buffer", markdown: page })).toBe(base);
  });

  it("marks a changed buffer unsaved, never saved", () => {
    const next = documentReducer(base, { type: "buffer", markdown: `${page}more` });
    expect(next.dirty).toBe(true);
    expect(next.save).toEqual({ kind: "unsaved" });
  });

  it("keeps the newest keystrokes unsaved when they arrived during the publish", () => {
    const next = documentReducer(base, { type: "saved", head, at: 20, stillDirty: true });
    expect(next.save).toEqual({ kind: "unsaved" });
    expect(next.dirty).toBe(true);
  });

  it("clears a conflict once a save succeeds", () => {
    const conflicted = {
      ...base,
      conflict: {
        currentRevision: "b".repeat(40),
        currentGeneration: 2,
        draftPreserved: true,
        baseRevision: head.revision,
      },
    };
    expect(
      documentReducer(conflicted, { type: "saved", head, at: 20, stillDirty: false }).conflict,
    ).toBeNull();
  });

  it("adopts a head published elsewhere only while nothing local is unsaved", () => {
    const newer: HeadSnapshot = {
      ...head,
      revision: "b".repeat(40),
      markdown: "new",
      updatedAt: 30,
    };
    const adopted = documentReducer(base, {
      type: "head_changed",
      head: newer,
      update: null,
      adopt: true,
    });
    expect(adopted.buffer).toBe("new");
    expect(adopted.dirty).toBe(false);

    const dirty = { ...base, dirty: true, buffer: "mine", save: { kind: "unsaved" } as const };
    const kept = documentReducer(dirty, {
      type: "head_changed",
      head: newer,
      update: null,
      adopt: false,
    });
    expect(kept.buffer).toBe("mine");
    expect(kept.head).toBe(newer);
  });

  it("re-derives read-only when an adopted head brings raw HTML or parser limits", () => {
    const html = documentReducer(base, {
      type: "head_changed",
      head: { ...head, hasRawHtml: true },
      update: null,
      adopt: true,
    });
    expect(html.readOnly).toBe("raw_html");
    const complex = documentReducer(base, {
      type: "head_changed",
      head: { ...head, parseMode: "fallback" },
      update: null,
      adopt: true,
    });
    expect(complex.readOnly).toBe("too_complex");
    const locked = documentReducer(
      { ...base, readOnly: "locked" },
      { type: "head_changed", head, update: null, adopt: true },
    );
    expect(locked.readOnly).toBe("locked");
  });

  it("keeps an agent update until it is dismissed", () => {
    const update = describeHeadChange(head, [], "simon");
    const withUpdate = documentReducer(base, {
      type: "head_changed",
      head,
      update,
      adopt: false,
    });
    expect(withUpdate.agentUpdate).toBe(update);
    const kept = documentReducer(withUpdate, {
      type: "head_changed",
      head,
      update: null,
      adopt: false,
    });
    expect(kept.agentUpdate).toBe(update);
    expect(documentReducer(kept, { type: "agent_update_dismissed" }).agentUpdate).toBeNull();
  });

  it("shows a loaded page as saved only when it has a published revision", () => {
    const loaded = documentReducer(base, {
      type: "loaded",
      head: { ...head, revision: null, updatedAt: null },
      buffer: "",
      baseRevision: null,
      dirty: false,
      conflict: null,
      draftSeq: 0,
      normalizationPending: false,
      readOnly: null,
    });
    expect(loaded.save).toEqual({ kind: "idle" });
  });
});

describe("canonicalOrNull", () => {
  it("returns the canonical form of an ordinary document", () => {
    expect(canonicalOrNull("# A\n")).toBe(canonicalFixture("# A\n"));
  });

  it("is null for a document past the parser work limits", () => {
    expect(canonicalOrNull("a*b ".repeat(2_500))).toBeNull();
  });
});

describe("describeHeadChange", () => {
  const head: HeadSnapshot = {
    revision: "a".repeat(40),
    generation: 1,
    markdown: page,
    author: "simon",
    updatedAt: 1,
    canonical: true,
    hasRawHtml: false,
    parseMode: "parsed",
    sections: [
      {
        sectionId,
        parentId: null,
        kind: "heading",
        depth: 2,
        heading: "Next steps",
        bytes: 10,
        subtreeBytes: 10,
        childCount: 0,
        lineStart: 5,
        lineEnd: 7,
      },
    ] as HeadSnapshot["sections"],
  };

  it("names the changed section, as the brief's compact event asks", () => {
    const update = describeHeadChange(head, [sectionId], "simon");
    expect(update.label).toBe("Updated Next steps");
    expect(update.heading).toBe("Next steps");
    expect(update.lineStart).toBe(5);
  });

  it("falls back to a document-level label naming who changed it", () => {
    expect(describeHeadChange(head, [], "simon").label).toBe("Simon updated this page");
    expect(describeHeadChange(head, [], "mcp").label).toBe("An agent updated this page");
    expect(describeHeadChange(head, [], "user").label).toBe("Another device updated this page");
  });

  it("ignores a section id the new head does not carry", () => {
    const update = describeHeadChange(head, [`s${"b".repeat(25)}`], "simon");
    expect(update.label).toBe("Simon updated this page");
    expect(update.lineStart).toBeNull();
  });
});

describe("loading the page", () => {
  it("shows the published head as saved", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    expect(result.current.state.buffer).toBe(page);
    expect(result.current.state.save.kind).toBe("saved");
    expect(result.current.state.dirty).toBe(false);
  });

  it("shows a page with no revision as empty and idle", async () => {
    const fake = new FakeDocuments();
    const { result } = mount(fake);
    await ready(result);
    expect(result.current.state.buffer).toBe("");
    expect(result.current.state.save).toEqual({ kind: "idle" });
  });

  it("restores a stored draft as unsaved work", async () => {
    const draft: DocumentDraft = {
      baseRevision: "1".padStart(40, "0") as DocumentDraft["baseRevision"],
      clientSeq: 4,
      markdown: `${page}\nA sentence I was typing.\n`,
      origin: "editor",
      updatedAt: 5,
    };
    const fake = new FakeDocuments({ commits: [{ markdown: page }], draft });
    const { result } = mount(fake);
    await ready(result);
    expect(result.current.state.buffer).toBe(draft.markdown);
    expect(result.current.state.dirty).toBe(true);
    expect(result.current.state.save).toEqual({ kind: "unsaved" });
    expect(result.current.state.draftSeq).toBe(4);
    expect(result.current.state.conflict).toBeNull();
  });

  it("opens conflict review for a draft whose base is no longer the head", async () => {
    const draft: DocumentDraft = {
      baseRevision: "1".padStart(40, "0") as DocumentDraft["baseRevision"],
      clientSeq: 2,
      markdown: `${page}\nmine\n`,
      origin: "editor",
      updatedAt: 5,
    };
    const fake = new FakeDocuments({
      commits: [{ markdown: page }, { markdown: `${page}\nSimon's\n`, author: "simon" }],
      draft,
    });
    const { result } = mount(fake);
    await ready(result);
    expect(result.current.state.conflict).toMatchObject({ draftPreserved: true });
    expect(result.current.state.buffer).toBe(draft.markdown);
  });

  it("opens conflict review for a draft a conflicting save preserved", async () => {
    const draft: DocumentDraft = {
      baseRevision: "1".padStart(40, "0") as DocumentDraft["baseRevision"],
      clientSeq: 2,
      markdown: `${page}\nmine\n`,
      origin: "conflict",
      updatedAt: 5,
    };
    const fake = new FakeDocuments({ commits: [{ markdown: page }], draft });
    const { result } = mount(fake);
    await ready(result);
    expect(result.current.state.conflict).not.toBeNull();
  });

  it("opens the page read-only when it contains raw HTML", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: "Some text<br>and more\n" }] });
    const { result } = mount(fake);
    await ready(result);
    expect(result.current.state.readOnly).toBe("raw_html");
  });

  it("opens the page read-only when it is past the parser work limits", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: "a*b ".repeat(2_500) }] });
    const { result } = mount(fake);
    await ready(result);
    expect(result.current.state.readOnly).toBe("too_complex");
  });

  it("reports a load failure in plain language and can be reloaded", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    fake.failNext = new ApiNetworkError();
    const { result } = mount(fake);
    await waitFor(() => expect(result.current.state.phase).toBe("failed"));
    expect(result.current.state.failure?.code).toBe("offline");
    act(() => result.current.reload());
    await ready(result);
    expect(result.current.state.buffer).toBe(page);
  });
});

describe("saving", () => {
  it("publishes three seconds after the last keystroke and then says Saved", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nA new line.\n`));
    expect(result.current.state.save).toEqual({ kind: "unsaved" });
    await act(async () => {
      timers.advance(SAVE_IDLE_MS);
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    expect(fake.markdown).toBe(`${page}\nA new line.\n`);
  });

  it("publishes at once on Mod+S", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nTyped.\n`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    expect(fake.calls.filter((call) => call.name === "publish")).toHaveLength(1);
  });

  it("sends the same idempotency key while one intent is in flight", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\none\n`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    act(() => result.current.setBuffer(`${page}\ntwo\n`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    const keys = fake.calls
      .filter((call) => call.name === "publish")
      .map((call) => (call.input as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("writes throttled drafts alongside the publish schedule", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    await act(async () => {
      result.current.setBuffer(`${page}\nA\n`);
    });
    await waitFor(() =>
      expect(fake.calls.filter((call) => call.name === "putDraft").length).toBeGreaterThan(0),
    );
    expect(fake.draft?.markdown).toBe(`${page}\nA\n`);
  });

  it("keeps the draft and offers a retry when a save fails", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nTyped.\n`));
    fake.failNext = new ApiNetworkError();
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("failed"));
    expect(result.current.state.buffer).toBe(`${page}\nTyped.\n`);
    await act(async () => {
      result.current.flush("retry");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    expect(fake.markdown).toBe(`${page}\nTyped.\n`);
  });

  it("replays the same intent on retry rather than starting a new one", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nTyped.\n`));
    fake.failNext = new ApiNetworkError();
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("failed"));
    await act(async () => {
      result.current.flush("retry");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    const keys = fake.calls
      .filter((call) => call.name === "publish")
      .map((call) => (call.input as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("marks the page read-only when the server refuses writes", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nTyped.\n`));
    fake.failNext = apiError(403, "document.read_only");
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.readOnly).toBe("locked"));
    expect(result.current.state.save.kind).toBe("failed");
  });

  it("reports the failure truthfully when Mod+S is pressed on an unchanged page", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    await act(async () => {
      result.current.flush("shortcut");
    });
    expect(fake.calls.some((call) => call.name === "publish")).toBe(false);
    expect(result.current.state.save.kind).toBe("saved");
  });
});

describe("the formatting-normalization commit (decision R7)", () => {
  const nonCanonical = "Overview\n========\n\n- one\n- two\n";

  it("publishes the normalization on its own before the first page-view edit", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: nonCanonical }] });
    const { result } = mount(fake, "page");
    await ready(result);
    expect(result.current.state.normalizationPending).toBe(true);
    act(() => result.current.setBuffer(`${canonicalFixture(nonCanonical)}\nmore\n`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    const kinds = fake.commits.map((commit) => commit.kind);
    expect(kinds).toEqual(["create", "normalization", "edit"]);
    expect(fake.commits[1]?.markdown).toBe(canonicalFixture(nonCanonical));
    expect(fake.commits[1]?.subject).toBe("Formatting normalized");
  });

  it("publishes no normalization from the raw view, which is lossless", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: nonCanonical }] });
    const { result } = mount(fake, "raw");
    await ready(result);
    act(() => result.current.setBuffer(`${nonCanonical}extra\n`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    expect(fake.commits.map((commit) => commit.kind)).toEqual(["create", "edit"]);
  });

  it("publishes it only once", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: nonCanonical }] });
    const { result } = mount(fake, "page");
    await ready(result);
    act(() => result.current.setBuffer(`${canonicalFixture(nonCanonical)}one\n`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    act(() => result.current.setBuffer(`${canonicalFixture(nonCanonical)}two\n`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    expect(fake.commits.filter((commit) => commit.kind === "normalization")).toHaveLength(1);
  });

  it("publishes it alone, and never an edit that reverts it, when nothing was typed", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: nonCanonical }] });
    const { result } = mount(fake, "page");
    await ready(result);
    await act(async () => {
      result.current.flush("blur");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    expect(fake.commits.map((commit) => commit.kind)).toEqual(["create", "normalization"]);
    expect(fake.markdown).toBe(canonicalFixture(nonCanonical));
    // The buffer follows the commit, so the next save builds on the canonical text.
    expect(result.current.state.buffer).toBe(canonicalFixture(nonCanonical));
    expect(result.current.state.dirty).toBe(false);
  });

  it("scopes its idempotency key to the revision it normalizes", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: nonCanonical }] });
    const { result } = mount(fake, "page");
    await ready(result);
    act(() => result.current.setBuffer(`${canonicalFixture(nonCanonical)}one\n`));
    // A normalization that fails keeps its key, so an exact retry replays rather than duplicating.
    fake.failNext = new ApiNetworkError();
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("failed"));
    // A revision published elsewhere moves the head, so the normalization now rewrites other text.
    fake.publishElsewhere("Other\n=====\n\n- a\n");
    await act(async () => {
      socket.headChanged(headEvent(fake.head?.revision ?? "", "simon"));
    });
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).not.toBe("saving"));
    const normalizations = fake.calls
      .filter((call) => call.name === "publish")
      .map((call) => call.input as { kind: string; baseRevision: string; idempotencyKey: string })
      .filter((input) => input.kind === "normalization");
    expect(normalizations.length).toBeGreaterThan(1);
    // Different bases are different intents: reusing one key across them is `idempotency.mismatch`.
    const first = normalizations[0] as { baseRevision: string; idempotencyKey: string };
    const last = normalizations[normalizations.length - 1] as {
      baseRevision: string;
      idempotencyKey: string;
    };
    expect(last.baseRevision).not.toBe(first.baseRevision);
    expect(last.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("owes nothing for a document that is already canonical", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: canonicalFixture(page) }] });
    const { result } = mount(fake, "page");
    await ready(result);
    expect(result.current.state.normalizationPending).toBe(false);
  });

  it("skips it for a document the canonical serializer cannot represent", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: "a*b ".repeat(2_500) }] });
    const { result } = mount(fake, "page");
    await ready(result);
    act(() => result.current.setBuffer(`${"a*b ".repeat(2_500)}x`));
    await act(async () => {
      result.current.flush("shortcut");
    });
    await waitFor(() => expect(result.current.state.save.kind).toBe("saved"));
    expect(fake.commits.some((commit) => commit.kind === "normalization")).toBe(false);
  });
});

describe("a revision published elsewhere", () => {
  it("adopts it and announces the named section when nothing local is unsaved", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    const commit = fake.publishElsewhere(page.replace("Pick three projects", "Pick four"));
    await act(async () => {
      socket.headChanged(headEvent(commit.revision, "simon"));
    });
    await waitFor(() => expect(result.current.state.buffer).toContain("Pick four"));
    expect(result.current.state.agentUpdate?.whileEditing).toBe(false);
    expect(result.current.state.dirty).toBe(false);
  });

  it("never replaces unsaved local writing, and says the update arrived while editing", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nmine\n`));
    const commit = fake.publishElsewhere(`${page}\nSimon's\n`);
    await act(async () => {
      socket.headChanged(headEvent(commit.revision, "simon"));
    });
    await waitFor(() => expect(result.current.state.agentUpdate).not.toBeNull());
    expect(result.current.state.buffer).toBe(`${page}\nmine\n`);
    expect(result.current.state.agentUpdate?.whileEditing).toBe(true);
  });

  it("ignores the announcement of this device's own publication", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    const before = fake.calls.filter((call) => call.name === "head").length;
    await act(async () => {
      socket.headChanged(headEvent(fake.head?.revision as string, "user"));
    });
    expect(fake.calls.filter((call) => call.name === "head")).toHaveLength(before);
  });

  it("re-reads when a snapshot names a head this device does not have", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    fake.publishElsewhere(`${page}\nnewer\n`);
    await act(async () => {
      socket.snapshotHead("b".repeat(40));
    });
    await waitFor(() => expect(result.current.state.buffer).toContain("newer"));
  });

  it("re-reads on a resync only when nothing local is unsaved", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nmine\n`));
    fake.publishElsewhere(`${page}\nnewer\n`);
    await act(async () => {
      socket.resync();
    });
    expect(result.current.state.buffer).toBe(`${page}\nmine\n`);
  });

  it("dismisses the update pill", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result } = mount(fake);
    await ready(result);
    const commit = fake.publishElsewhere(`${page}\nSimon's\n`);
    await act(async () => {
      socket.headChanged(headEvent(commit.revision, "simon"));
    });
    await waitFor(() => expect(result.current.state.agentUpdate).not.toBeNull());
    act(() => result.current.dismissAgentUpdate());
    expect(result.current.state.agentUpdate).toBeNull();
  });

  it("unsubscribes when the page unmounts", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result, unmount } = mount(fake);
    await ready(result);
    expect(socket.size).toBe(1);
    unmount();
    expect(socket.size).toBe(0);
  });
});

describe("conflicts", () => {
  async function conflicted() {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const view = mount(fake);
    await ready(view.result);
    act(() => view.result.current.setBuffer(`${page}\nmine\n`));
    fake.publishElsewhere(`${page}\nSimon's\n`);
    await act(async () => {
      view.result.current.flush("shortcut");
    });
    await waitFor(() => expect(view.result.current.state.conflict).not.toBeNull());
    return { fake, ...view };
  }

  it("reports the conflict and keeps the draft, never claiming an overwrite", async () => {
    const { result } = await conflicted();
    expect(result.current.state.conflict?.draftPreserved).toBe(true);
    expect(result.current.state.buffer).toBe(`${page}\nmine\n`);
    expect(result.current.state.save).toMatchObject({
      kind: "failed",
      failure: { code: "document.conflict" },
    });
  });

  it("publishes a reviewed merge on top of the current head and closes the conflict", async () => {
    const { fake, result } = await conflicted();
    await act(async () => {
      await result.current.resolveConflict(`${page}\nmine and Simon's\n`);
    });
    await waitFor(() => expect(result.current.state.conflict).toBeNull());
    expect(fake.markdown).toBe(`${page}\nmine and Simon's\n`);
    expect(result.current.state.save.kind).toBe("saved");
  });

  it("keeps text typed while the merge was publishing unsaved rather than losing it", async () => {
    const { fake, result } = await conflicted();
    await act(async () => {
      const publishing = result.current.resolveConflict(`${page}\nmerged\n`);
      result.current.setBuffer(`${page}\nmerged and more\n`);
      await publishing;
    });
    expect(fake.markdown).toBe(`${page}\nmerged\n`);
    expect(result.current.state.buffer).toBe(`${page}\nmerged and more\n`);
    expect(result.current.state.dirty).toBe(true);
    expect(result.current.state.save.kind).toBe("unsaved");
    // The scheduler was restarted, so the extra text still reaches the server on its own.
    await act(async () => {
      timers.advance(SAVE_IDLE_MS);
    });
    await waitFor(() => expect(fake.markdown).toBe(`${page}\nmerged and more\n`));
  });

  it("reports a second conflict when the head moved again during review", async () => {
    const { fake, result } = await conflicted();
    fake.publishElsewhere(`${page}\neven newer\n`);
    await act(async () => {
      await result.current.resolveConflict(`${page}\nmerged\n`);
    });
    await waitFor(() => expect(result.current.state.conflict).not.toBeNull());
    expect(result.current.state.buffer).toBe(`${page}\nmerged\n`);
  });

  it("keeps editing without publishing when the person chooses to", async () => {
    const { fake, result } = await conflicted();
    const published = fake.commits.length;
    act(() => result.current.keepDraft());
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.buffer).toBe(`${page}\nmine\n`);
    expect(fake.commits).toHaveLength(published);
  });

  it("drops the draft and shows the saved page when the person discards it", async () => {
    const { fake, result } = await conflicted();
    await act(async () => {
      await result.current.discardDraft();
    });
    await waitFor(() => expect(result.current.state.buffer).toBe(`${page}\nSimon's\n`));
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.dirty).toBe(false);
    expect(fake.calls.some((call) => call.name === "deleteDraft")).toBe(true);
  });

  it("shows whatever the server still holds when the draft could not be deleted", async () => {
    const { fake, result } = await conflicted();
    fake.failNext = new ApiNetworkError();
    await act(async () => {
      await result.current.discardDraft();
    });
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    // The delete did not reach the server, so the draft is still stored and the page says so rather
    // than claiming the discard worked.
    expect(fake.draft?.markdown).toBe(`${page}\nmine\n`);
    expect(result.current.state.buffer).toBe(`${page}\nmine\n`);
    expect(result.current.state.conflict).not.toBeNull();
  });
});

describe("leaving the page", () => {
  it("publishes what is pending on unmount, as a task switch does", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result, unmount } = mount(fake);
    await ready(result);
    act(() => result.current.setBuffer(`${page}\nunsaved\n`));
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fake.markdown).toBe(`${page}\nunsaved\n`));
  });

  it("publishes nothing when the buffer is clean", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    const { result, unmount } = mount(fake);
    await ready(result);
    const published = fake.commits.length;
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(fake.commits).toHaveLength(published);
  });
});
