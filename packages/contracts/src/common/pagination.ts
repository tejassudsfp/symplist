import { z } from "zod";

/** Cursor pagination query shared by list endpoints. Cursors are opaque to clients. */
export const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** One page of results; `nextCursor` is null on the last page. */
export interface Page<Item> {
  items: readonly Item[];
  nextCursor: string | null;
}
