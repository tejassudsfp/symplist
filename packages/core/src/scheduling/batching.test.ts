import { type DbClient, type Statement, sql } from "@symplist/db";
import { describe, expect, it, vi } from "vitest";
import { ScannerBatchDb } from "./batching.ts";

describe("scan-scoped D1 batching", () => {
  it("keeps each atomic plan contiguous and returns only its own verification rows", async () => {
    const batch = vi.fn(async (statements: readonly Statement[]) =>
      statements.map((statement) => ({
        results: [{ value: statement.params[0] ?? "" }],
        meta: { changes: 0, duration: 0, last_row_id: 0, rows_read: 0, rows_written: 0 },
      })),
    );
    const db = new ScannerBatchDb({ batch } as unknown as DbClient);
    const output = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        db.batch([
          sql("SELECT :value", { value: String(index) }),
          sql("SELECT :value", { value: `${index}-check` }),
        ]),
      ),
    );
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([50, 50]);
    expect(output[27]?.map((item) => item.results[0]?.value)).toEqual(["27", "27-check"]);
  });
  it("propagates a transaction failure to every included plan, never a fake success", async () => {
    const batch = vi.fn().mockRejectedValue(new Error("D1 unavailable"));
    const db = new ScannerBatchDb({ batch } as unknown as DbClient);
    const result = await Promise.allSettled([db.first(sql("SELECT 1")), db.first(sql("SELECT 2"))]);
    expect(result.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(batch).toHaveBeenCalledOnce();
  });
});
