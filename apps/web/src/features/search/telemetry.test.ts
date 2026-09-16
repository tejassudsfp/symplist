import { analyticsEventOwner, validateAnalyticsEvent } from "@symplist/analytics";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reportSearchUsed,
  resultCountBucket,
  type SearchUsedEvent,
  setSearchUsedReporter,
} from "./telemetry.ts";

afterEach(() => {
  setSearchUsedReporter(null);
});

describe("search_used reporting", () => {
  it("buckets result counts as the event schema requires (decision C5.3)", () => {
    expect(resultCountBucket(0)).toBe("0");
    expect(resultCountBucket(1)).toBe("1-5");
    expect(resultCountBucket(5)).toBe("1-5");
    expect(resultCountBucket(6)).toBe("6-20");
    expect(resultCountBucket(20)).toBe("6-20");
    expect(resultCountBucket(21)).toBe("21+");
  });

  it("builds properties the analytics allowlist accepts, with no query or title", () => {
    const event: SearchUsedEvent = {
      surface: "full_search",
      include_archive: true,
      include_chat: false,
      result_count: "1-5",
    };
    expect(analyticsEventOwner("search_used")).toBe("client");
    expect(validateAnalyticsEvent("client", "search_used", event)).toMatchObject({ ok: true });
    // A query or any other free text is refused by the allowlist, so it can never be sent.
    expect(
      validateAnalyticsEvent("client", "search_used", { ...event, query: "portfolio" }),
    ).toEqual({ ok: false, reason: "invalid_properties" });
    expect(validateAnalyticsEvent("server", "search_used", event)).toEqual({
      ok: false,
      reason: "wrong_owner",
    });
  });

  it("sends nothing until the analytics feature registers a reporter", () => {
    const event: SearchUsedEvent = {
      surface: "command_palette",
      include_archive: false,
      include_chat: false,
      result_count: "0",
    };
    expect(() => reportSearchUsed(event)).not.toThrow();
    const reporter = vi.fn();
    setSearchUsedReporter(reporter);
    reportSearchUsed(event);
    expect(reporter).toHaveBeenCalledWith(event);
    setSearchUsedReporter(null);
    reportSearchUsed(event);
    expect(reporter).toHaveBeenCalledTimes(1);
  });
});
