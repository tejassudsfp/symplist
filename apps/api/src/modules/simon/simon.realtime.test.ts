import { describe, expect, it } from "vitest";
import { boundedSimonLive } from "./simon.realtime.ts";

describe("Simon reconnect tail budget", () => {
  it("keeps a contiguous newest tail within 256 KiB and reports truncation", () => {
    const events = Array.from({ length: 100 }, (_, seq) => ({
      seq,
      id: String(seq),
      type: "chunk",
      data: "x".repeat(10_000),
    }));
    const result = boundedSimonLive(events);
    expect(result.liveTruncated).toBe(true);
    expect(result.live.length).toBeGreaterThan(0);
    expect(result.live.at(-1)?.seq).toBe(99);
    expect(result.live).toEqual(events.slice(-result.live.length));
    expect(Buffer.byteLength(JSON.stringify(result.live))).toBeLessThan(262_144);
  });
  it("refuses a single oversized frame without reaching back into an earlier step", () => {
    const events = [
      { seq: 1, id: "1", type: "chunk", data: "earlier" },
      { seq: 2, id: "2", type: "chunk", data: "x".repeat(262_144) },
    ];
    expect(boundedSimonLive(events)).toEqual({ live: [], liveTruncated: true });
    expect(boundedSimonLive(events.slice(0, 1))).toEqual({
      live: events.slice(0, 1),
      liveTruncated: false,
    });
  });
});
