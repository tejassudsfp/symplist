/**
 * REST request and response schemas owned by the connections feature (§14).
 * Export Zod schemas with a `connections`-specific name so the contracts index stays collision free.
 */
import { idSchema } from "../common/ids.ts";
import { z } from "../common/zod.ts";

/** A single owner-scoped resource id in a path — an MCP grant, or an OAuth request. */
export const connectionParamsSchema = z.strictObject({ id: idSchema });
export type ConnectionParams = z.infer<typeof connectionParamsSchema>;
