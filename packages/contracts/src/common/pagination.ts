import { z } from "./zod.ts";

/** The largest page a list endpoint returns. */
export const pageLimitMax = 100;

/** The page size used when a request omits `limit`. */
export const pageLimitDefault = 50;

/**
 * An opaque pagination cursor: URL-safe text of at most 512 characters. Clients never parse cursors;
 * servers encode what they need (for example a pinned index generation, §10.1, or a pinned change
 * target, §9.4) and validate it again when it comes back.
 */
export const cursorSchema = z
  .string({ error: "Expected a cursor" })
  .regex(/^[A-Za-z0-9_-]{1,512}$/, { error: "Expected an opaque URL-safe cursor" });

export type Cursor = z.infer<typeof cursorSchema>;

/**
 * A page size between 1 and `pageLimitMax`. Query strings carry it as canonical decimal text
 * (`"25"`); JSON bodies carry a number. Signs, decimals, exponents, whitespace and leading zeros are
 * rejected rather than coerced.
 */
export const pageLimitSchema = z
  .union([
    z.number({ error: "Expected a page limit" }),
    z
      .string({ error: "Expected a page limit" })
      .regex(/^[1-9][0-9]{0,2}$/, { error: "Expected a page limit" })
      .transform(Number),
  ])
  .pipe(
    z
      .number()
      .int({ error: "Expected a whole page limit" })
      .min(1, { error: `Expected a page limit between 1 and ${pageLimitMax}` })
      .max(pageLimitMax, { error: `Expected a page limit between 1 and ${pageLimitMax}` }),
  );

/**
 * Cursor pagination query shared by list endpoints. Strict: features `.extend()` it with their own
 * filters, and unknown parameters are rejected.
 */
export const pageQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** One page of results; `nextCursor` is null on the last page. */
export interface Page<Item> {
  items: readonly Item[];
  nextCursor: string | null;
}

/** The response schema for one page of `item`, with at most `pageLimitMax` items. */
export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    items: z.array(item).max(pageLimitMax),
    nextCursor: cursorSchema.nullable(),
  });
}
