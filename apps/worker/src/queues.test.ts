import { describe, expect, it } from "vitest";
import { d1, d1Git, d1QueueFamily, reminderScan } from "./queues";

describe("D1 queue family (§3.1)", () => {
  it("declares the three family queues with their concurrency limits", () => {
    expect(d1).toMatchObject({ name: "d1", concurrencyLimit: 4 });
    expect(d1Git).toMatchObject({ name: "d1-git", concurrencyLimit: 2 });
    expect(reminderScan).toMatchObject({ name: "reminder-scan", concurrencyLimit: 1 });
  });

  it("bounds the family to seven concurrent D1-using processes", () => {
    const total = d1QueueFamily.reduce((sum, family) => sum + (family.concurrencyLimit ?? 0), 0);
    expect(total).toBe(7);
  });
});
