import { createLocalSqliteClient } from "@symplist/db";
import { describe, expect, it, vi } from "vitest";
import { onSearchIndexRequested, requestSearchIndex } from "./request-signal.ts";

describe("search coordinator hints", () => {
  it("isolates database instances, unsubscribes and contains listener failures", async () => {
    const one = createLocalSqliteClient({ path: ":memory:" });
    const two = createLocalSqliteClient({ path: ":memory:" });
    const observed = vi.fn();
    const other = vi.fn();
    const request = { ownerId: "owner", reason: "stale" as const };
    try {
      const off = onSearchIndexRequested(one, observed);
      onSearchIndexRequested(one, () => {
        throw new Error("listener failed");
      });
      onSearchIndexRequested(two, other);
      expect(() => requestSearchIndex(one, request)).not.toThrow();
      expect(observed).toHaveBeenCalledWith(request);
      expect(other).not.toHaveBeenCalled();
      off();
      requestSearchIndex(one, request);
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      await one.close();
      await two.close();
    }
  });
});
