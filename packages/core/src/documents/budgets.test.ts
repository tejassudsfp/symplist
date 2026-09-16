import { describe, expect, it } from "vitest";
import { clampToBudget, GrantRetrievalBudgets } from "./budgets.ts";

describe("concurrent grant retrieval accounting", () => {
  it("refuses the second overlapping delivery without consuming bytes it never returned", () => {
    const budgets = new GrantRetrievalBudgets({ now: () => 1, capBytes: 100 });
    const first = budgets.forGrant("one");
    const second = budgets.forGrant("one");
    expect(clampToBudget(first, 80, 1)).toBe(80);
    expect(clampToBudget(second, 80, 1)).toBe(80);
    first.consume(80);
    expect(() => second.consume(80)).toThrow("document.budget_exhausted");
    expect(second.consumedBytes).toBe(0);
    expect(second.remaining()).toBe(20);
    second.consume(20);
    expect(first.remaining()).toBe(0);
    expect(budgets.forGrant("other").remaining()).toBe(100);
  });
});
