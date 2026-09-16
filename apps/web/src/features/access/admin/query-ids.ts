import {
  type InviteId,
  idSchema,
  inviteIdSchema,
  type UserId,
  userIdSchema,
} from "@symplist/contracts";
import type { z } from "zod";

/** A query parameter parsed with a contracts schema; anything malformed is simply not a filter. */
function parseParam<Schema extends z.ZodType>(
  schema: Schema,
  value: string | null,
): z.infer<Schema> | null {
  if (value === null) return null;
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function userIdParam(value: string | null): UserId | null {
  return parseParam(userIdSchema, value);
}

export function inviteIdParam(value: string | null): InviteId | null {
  return parseParam(inviteIdSchema, value);
}

export function idParam(value: string | null): string | null {
  return parseParam(idSchema, value);
}
