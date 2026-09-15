import { z } from "zod";

/**
 * Entity identifiers are UUIDv7 strings (§3.4). They identify rows and objects but are never used
 * for ordering correctness; lists order by fractional `position` strings instead.
 */
export const idSchema = z.uuid({ version: "v7" });

/** A UUIDv7 identifier string. */
export type Id = z.infer<typeof idSchema>;
