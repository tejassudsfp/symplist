import { idempotencyKeyHeader } from "@symplist/contracts";
import type { Request } from "express";
import { ApiError } from "../../common/errors/api-error.ts";

/**
 * The request id an admin action's audit event is unique by (`beta_admin_events.request_id`): the
 * action, the administrator and the request's Idempotency-Key, so a retried request appends nothing
 * twice. The interceptor has already validated the key.
 */
export function adminRequestId(
  req: Request,
  action: string,
  adminId: string,
  subjectId: string,
): string {
  const key = req.headers[idempotencyKeyHeader.toLowerCase()];
  if (typeof key !== "string" || key.length === 0) throw ApiError.internal();
  return `${action}:${adminId}:${subjectId}:${key}`;
}
