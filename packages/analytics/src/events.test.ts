import { describe, expect, it } from "vitest";
import {
  analyticsEventNames,
  analyticsEventOwner,
  analyticsEventVersion,
  isAnalyticsEventName,
  validateAnalyticsEvent,
} from "./events.ts";

describe("analytics event allowlist (note 17, §15)", () => {
  it("contains the note 17 events plus quick chat, and nothing else", () => {
    expect([...analyticsEventNames].sort()).toEqual(
      [
        "task_created",
        "task_completed",
        "task_moved",
        "search_used",
        "appearance_changed",
        "reminder_created",
        "handoff_prepared",
        "artifact_share_created",
        "quick_chat_started",
        "quick_chat_saved",
      ].sort(),
    );
  });

  it("gives every event exactly one owner and a version", () => {
    for (const name of analyticsEventNames) {
      expect(["client", "server"]).toContain(analyticsEventOwner(name));
      expect(analyticsEventVersion(name)).toBeGreaterThanOrEqual(1);
    }
    expect(analyticsEventOwner("search_used")).toBe("client");
    expect(analyticsEventOwner("task_created")).toBe("server");
  });

  it("accepts enumerated properties and adds event_version", () => {
    expect(
      validateAnalyticsEvent("server", "task_moved", {
        from_collection: "now",
        to_collection: "later",
        source: "user",
      }),
    ).toEqual({
      ok: true,
      event: "task_moved",
      properties: {
        from_collection: "now",
        to_collection: "later",
        source: "user",
        event_version: 1,
      },
    });
  });

  it.each([
    ["page_viewed", {}],
    ["$pageview", {}],
    ["__proto__", {}],
    ["toString", {}],
    ["Task_Created", { source: "user", collection: "now", is_subtask: false }],
  ])("rejects the unknown event %j", (name, properties) => {
    expect(isAnalyticsEventName(name)).toBe(false);
    expect(validateAnalyticsEvent("server", name, properties)).toEqual({
      ok: false,
      reason: "unknown_event",
    });
  });

  it("rejects events sent by the side that does not own them", () => {
    expect(
      validateAnalyticsEvent("client", "task_created", {
        source: "user",
        collection: "now",
        is_subtask: false,
      }),
    ).toEqual({ ok: false, reason: "wrong_owner" });
    expect(validateAnalyticsEvent("server", "quick_chat_started", { entry: "button" })).toEqual({
      ok: false,
      reason: "wrong_owner",
    });
  });

  it.each([
    [
      "free text in an enumerated field",
      "search_used",
      {
        surface: "Refresh my portfolio",
        include_archive: false,
        include_chat: false,
        result_count: "0",
      },
    ],
    [
      "a search query",
      "search_used",
      {
        surface: "full_search",
        include_archive: false,
        include_chat: false,
        result_count: "0",
        query: "portfolio",
      },
    ],
    [
      "an exact result count",
      "search_used",
      { surface: "full_search", include_archive: false, include_chat: false, result_count: 3 },
    ],
    [
      "a custom accent color",
      "appearance_changed",
      { changed: "accent", theme: "studio", accent: "#2F5FD0", mode: "light" },
    ],
    [
      "a task id",
      "quick_chat_saved",
      { collection: "now", task_id: "0192f0a0-0000-7000-8000-000000000101" },
    ],
    ["a URL", "quick_chat_started", { entry: "https://app.symplist.example/now" }],
    ["a missing property", "task_completed", { collection: "now" }],
    [
      "a boolean as a string",
      "task_created",
      { source: "user", collection: "now", is_subtask: "false" },
    ],
    [
      "a move to the same collection",
      "task_moved",
      { from_collection: "now", to_collection: "now", source: "user" },
    ],
    [
      "a caller-supplied event_version",
      "quick_chat_saved",
      { collection: "now", event_version: 9 },
    ],
    ["a non-object", "quick_chat_saved", "now"],
  ])("rejects %s", (_label, name, properties) => {
    const owner = analyticsEventOwner(name as Parameters<typeof analyticsEventOwner>[0]);
    expect(validateAnalyticsEvent(owner, name, properties)).toEqual({
      ok: false,
      reason: "invalid_properties",
    });
  });
});
