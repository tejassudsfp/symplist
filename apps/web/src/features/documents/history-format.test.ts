import type {
  DocumentAuthor,
  DocumentCommitKind,
  DocumentHistoryEntry,
  DocumentSectionChange,
} from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import {
  actorLabel,
  changeStatusLabel,
  changeSummary,
  diffLineLabel,
  entryDescription,
  exactTime,
  groupHistory,
  groupSummary,
  HISTORY_GROUP_WINDOW_MS,
  kindLabel,
  relativeTime,
  sectionLabel,
  shortRevision,
} from "./history-format.ts";

const now = 1_758_000_000_000;

function entry(
  overrides: Partial<DocumentHistoryEntry> & { committedAt: number },
): DocumentHistoryEntry {
  return {
    revision: (overrides.revision ??
      `${overrides.committedAt}`.padStart(40, "0")) as DocumentHistoryEntry["revision"],
    parentRevision: null,
    generation: 1,
    author: "user",
    kind: "edit",
    restoredFrom: null,
    subject: "Updated Next steps",
    ...overrides,
  } as DocumentHistoryEntry;
}

describe("actorLabel", () => {
  it("says You, Simon or An agent and never an internal id", () => {
    const authors: DocumentAuthor[] = ["user", "simon", "mcp"];
    expect(authors.map(actorLabel)).toEqual(["You", "Simon", "An agent"]);
  });
});

describe("shortRevision", () => {
  it("is the seven-character technical id, shown only as a secondary detail", () => {
    expect(shortRevision("0123456789abcdef".padEnd(40, "0"))).toBe("0123456");
  });
});

describe("relativeTime", () => {
  it("reads calmly at every scale", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 59_000, now)).toBe("just now");
    expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTime(now - 3_600_000, now)).toBe("1 hour ago");
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe("5 hours ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(relativeTime(now - 8 * 86_400_000, now)).toBe("1 week ago");
    expect(relativeTime(now - 20 * 86_400_000, now)).toBe("2 weeks ago");
    expect(relativeTime(now - 200 * 86_400_000, now)).toBe("over a month ago");
  });

  it("never reads as the future when a clock is ahead", () => {
    expect(relativeTime(now + 10_000, now)).toBe("just now");
  });
});

describe("exactTime", () => {
  it("is a full date and time, so nothing depends on guessing what a relative label covers", () => {
    const text = exactTime(now, "en-GB");
    expect(text.length).toBeGreaterThan(8);
    expect(text).toMatch(/\d/);
  });
});

describe("kindLabel", () => {
  it("badges only the revisions that are not ordinary edits", () => {
    const kinds: DocumentCommitKind[] = ["create", "normalization", "restore", "edit"];
    expect(kinds.map(kindLabel)).toEqual(["First version", "Formatting", "Restored", null]);
  });
});

describe("groupHistory", () => {
  it("groups consecutive commits by one author inside the 10-minute window", () => {
    const groups = groupHistory([
      entry({ committedAt: now, author: "user" }),
      entry({ committedAt: now - 60_000, author: "user" }),
      entry({ committedAt: now - 120_000, author: "user" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(3);
    expect(groups[0]?.author).toBe("user");
  });

  it("starts a new group when the author changes", () => {
    const groups = groupHistory([
      entry({ committedAt: now, author: "user" }),
      entry({ committedAt: now - 60_000, author: "simon" }),
    ]);
    expect(groups.map((group) => group.author)).toEqual(["user", "simon"]);
  });

  it("starts a new group once the gap passes the window", () => {
    const groups = groupHistory([
      entry({ committedAt: now, author: "user" }),
      entry({ committedAt: now - HISTORY_GROUP_WINDOW_MS - 1, author: "user" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("keeps a commit exactly at the window edge in the same group", () => {
    const groups = groupHistory([
      entry({ committedAt: now, author: "user" }),
      entry({ committedAt: now - HISTORY_GROUP_WINDOW_MS, author: "user" }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("measures the gap against the previous commit, not the first of the group", () => {
    const groups = groupHistory([
      entry({ committedAt: now, author: "user" }),
      entry({ committedAt: now - 9 * 60_000, author: "user" }),
      entry({ committedAt: now - 18 * 60_000, author: "user" }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("keys every group by its newest revision and returns nothing for no entries", () => {
    const newest = entry({ committedAt: now, revision: "a".repeat(40) });
    expect(groupHistory([newest])[0]?.key).toBe("a".repeat(40));
    expect(groupHistory([])).toEqual([]);
  });
});

describe("groupSummary", () => {
  it("counts revisions in the singular and plural", () => {
    expect(groupSummary({ key: "k", author: "user", entries: [entry({ committedAt: now })] })).toBe(
      "1 revision",
    );
    expect(
      groupSummary({
        key: "k",
        author: "user",
        entries: [entry({ committedAt: now }), entry({ committedAt: now - 1 })],
      }),
    ).toBe("2 revisions");
  });
});

describe("changeSummary and its labels", () => {
  const change = (status: DocumentSectionChange["status"]): DocumentSectionChange =>
    ({
      status,
      sectionId: null,
      baselineSectionId: null,
      kind: "heading",
      depth: 2,
      heading: "Next steps",
      bytes: 10,
    }) as DocumentSectionChange;

  it("counts added, changed and removed in words", () => {
    expect(changeSummary([change("added"), change("added"), change("modified")])).toBe(
      "2 added, 1 changed",
    );
    expect(changeSummary([change("removed")])).toBe("1 removed");
    expect(changeSummary([])).toBe("No sections changed");
  });

  it("names each status in a word, never by colour", () => {
    expect(changeStatusLabel("added")).toBe("Added");
    expect(changeStatusLabel("modified")).toBe("Changed");
    expect(changeStatusLabel("removed")).toBe("Removed");
  });

  it("labels a diff line for a screen reader and leaves context unlabelled", () => {
    expect(diffLineLabel("added")).toBe("Added");
    expect(diffLineLabel("removed")).toBe("Removed");
    expect(diffLineLabel("context")).toBeNull();
  });
});

describe("sectionLabel", () => {
  it("prefers the heading and otherwise says so in words, never an opaque id", () => {
    const base = { status: "added", sectionId: null, baselineSectionId: null, depth: 0, bytes: 1 };
    expect(
      sectionLabel({ ...base, kind: "heading", heading: "Links" } as DocumentSectionChange),
    ).toBe("Links");
    expect(
      sectionLabel({ ...base, kind: "preamble", heading: null } as DocumentSectionChange),
    ).toBe("Opening text");
    expect(sectionLabel({ ...base, kind: "block", heading: null } as DocumentSectionChange)).toBe(
      "A block without a heading",
    );
  });
});

describe("entryDescription", () => {
  it("reads as one sentence with the actor, the time and the subject", () => {
    expect(entryDescription(entry({ committedAt: now - 300_000 }), now)).toBe(
      "You, 5 minutes ago: Updated Next steps",
    );
  });

  it("includes the kind badge when there is one", () => {
    expect(
      entryDescription(entry({ committedAt: now, author: "simon", kind: "restore" }), now),
    ).toBe("Simon, just now, Restored: Updated Next steps");
  });
});
