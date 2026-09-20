import { describe, expect, it } from "vitest";
import { idSchema } from "./ids.ts";
import {
  cursorSchema,
  pageLimitDefault,
  pageLimitMax,
  pageLimitSchema,
  pageQuerySchema,
  pageSchema,
} from "./pagination.ts";
import { z } from "./zod.ts";

describe("pagination", () => {
  it("parses canonical query-string and JSON limits", () => {
    expect(pageLimitSchema.parse("25")).toBe(25);
    expect(pageLimitSchema.parse(100)).toBe(100);
    expect(pageLimitSchema.parse("1")).toBe(1);
    expect(pageLimitDefault).toBeLessThanOrEqual(pageLimitMax);
  });

  it.each(["0", "101", "-1", "1.5", "1e2", " 5", "05", "", "ten", 0, 101, 2.5, Number.NaN, null])(
    "rejects the limit %j instead of coercing it",
    (value) => {
      expect(pageLimitSchema.safeParse(value).success).toBe(false);
    },
  );

  it("accepts opaque URL-safe cursors of bounded length only", () => {
    expect(cursorSchema.parse("eyJnIjo0Mn0")).toBe("eyJnIjo0Mn0");
    for (const cursor of ["", "a".repeat(513), "abc=", "a/b", "a+b", "a b"]) {
      expect(cursorSchema.safeParse(cursor).success).toBe(false);
    }
  });

  it("parses page queries strictly", () => {
    expect(pageQuerySchema.parse({ cursor: "abc", limit: "10" })).toEqual({
      cursor: "abc",
      limit: 10,
    });
    expect(pageQuerySchema.parse({})).toEqual({});
    expect(pageQuerySchema.safeParse({ limit: "10", offset: "5" }).success).toBe(false);
    const filtered = pageQuerySchema.extend({ collection: z.enum(["now", "later"]) });
    expect(filtered.parse({ collection: "now" })).toEqual({ collection: "now" });
    expect(filtered.safeParse({ collection: "now", sort: "title" }).success).toBe(false);
  });

  it("round-trips a page and rejects oversized or malformed pages", () => {
    const schema = pageSchema(z.strictObject({ id: idSchema }));
    const page = { items: [{ id: "0199a5a0-7c1e-7b3a-9f2e-3c4d5e6f7a8b" }], nextCursor: null };
    expect(schema.parse(JSON.parse(JSON.stringify(page)))).toEqual(page);
    expect(schema.parse({ items: [], nextCursor: "next" })).toEqual({
      items: [],
      nextCursor: "next",
    });
    expect(schema.safeParse({ items: [] }).success).toBe(false);
    expect(schema.safeParse({ ...page, total: 1 }).success).toBe(false);
    expect(schema.safeParse({ items: [{ id: "x" }], nextCursor: null }).success).toBe(false);
    const tooMany = Array.from({ length: pageLimitMax + 1 }, () => page.items[0]);
    expect(schema.safeParse({ items: tooMany, nextCursor: null }).success).toBe(false);
  });
});
