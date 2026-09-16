import { describe, expect, it } from "vitest";
import {
  collectionOrder,
  contentTypeOrder,
  defaultSearchFilters,
  describeDeadline,
  describeScope,
  joinLabels,
  toggleInList,
  validateDeadline,
  viewerTimeZone,
} from "./filters.ts";

describe("search filters", () => {
  it("defaults to active titles and documents across every collection (note 14)", () => {
    expect(defaultSearchFilters.collections).toEqual(["now", "later", "unclassified"]);
    expect(defaultSearchFilters.types).toEqual(["tasks", "documents"]);
    expect(defaultSearchFilters.archive).toBe("exclude");
    expect(defaultSearchFilters.deadline.choice).toBe("any");
  });

  it("keeps at least one collection and one content type selected", () => {
    const one = toggleInList(collectionOrder, ["now"], "now");
    expect(one).toEqual(["now"]);
    expect(toggleInList(contentTypeOrder, ["tasks", "documents"], "chat")).toEqual([
      "tasks",
      "documents",
      "chat",
    ]);
    expect(toggleInList(contentTypeOrder, ["tasks", "chat"], "tasks")).toEqual(["chat"]);
  });

  it("always states the scope, including the archive opt-in and chat", () => {
    expect(
      describeScope({
        collections: ["now", "later", "unclassified"],
        archive: "exclude",
        types: ["tasks", "documents"],
        deadline: null,
      }),
    ).toBe(
      "Task titles and documents in Now, Later and Unclassified. Archived tasks aren't included.",
    );
    expect(
      describeScope({
        collections: ["now"],
        archive: "only",
        types: ["chat"],
        deadline: null,
      }),
    ).toBe("Chat in Now. Only archived tasks.");
    expect(
      describeScope({
        collections: ["now", "later"],
        archive: "include",
        types: ["tasks"],
        deadline: { kind: "overdue", timeZone: "America/Los_Angeles" },
      }),
    ).toBe(
      "Task titles in Now and Later, overdue (America/Los_Angeles). Archived tasks are included.",
    );
  });

  it("labels the comparison time zone of every deadline filter (note 14)", () => {
    expect(describeDeadline(null)).toBeNull();
    expect(describeDeadline({ kind: "has" })).toBe("with a deadline");
    expect(describeDeadline({ kind: "due_today", timeZone: "Asia/Kolkata" })).toBe(
      "due today (Asia/Kolkata)",
    );
    expect(
      describeDeadline({
        kind: "range",
        from: "2026-09-01",
        to: "2026-09-30",
        timeZone: "Asia/Kolkata",
      }),
    ).toContain("(Asia/Kolkata)");
  });

  it("refuses a malformed date range instead of sending it", () => {
    const zone = "America/Los_Angeles";
    expect(validateDeadline({ choice: "any", from: "", to: "" }, zone)).toEqual({
      ok: true,
      filter: null,
    });
    expect(validateDeadline({ choice: "range", from: "", to: "" }, zone)).toEqual({
      ok: false,
      message: "Choose both dates for the range",
    });
    expect(
      validateDeadline({ choice: "range", from: "2026-02-30", to: "2026-03-01" }, zone),
    ).toEqual({ ok: false, message: "The start date isn't a real date" });
    expect(
      validateDeadline({ choice: "range", from: "2026-03-05", to: "2026-03-01" }, zone),
    ).toEqual({ ok: false, message: "The range ends before it starts" });
    expect(
      validateDeadline({ choice: "range", from: "2026-03-01", to: "2026-03-05" }, zone),
    ).toEqual({
      ok: true,
      filter: { kind: "range", from: "2026-03-01", to: "2026-03-05", timeZone: zone },
    });
  });

  it("joins labels in plain language and resolves a usable time zone", () => {
    expect(joinLabels([])).toBe("");
    expect(joinLabels(["Now"])).toBe("Now");
    expect(joinLabels(["Now", "Later", "Unclassified"])).toBe("Now, Later and Unclassified");
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: viewerTimeZone() })).not.toThrow();
  });
});
