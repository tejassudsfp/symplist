import type { OperationalLog, OperationalLogFields } from "../../infra/scheduler/runtime.ts";
import type { AppLogger } from "./logger.ts";

/**
 * The operational log of the realtime gateway, internal endpoints, executors and local scheduler,
 * written through the api's structured logger (§6.3): each event keeps its stable code and its fields
 * pass the same shape-based redaction as every other log line, inside the current request context
 * when there is one. Nest's own logger would reduce these lines to redacted framework messages.
 */
export function appOperationalLog(logger: AppLogger): OperationalLog {
  return Object.freeze({
    info: (event: string, fields?: OperationalLogFields) => logger.info(event, fields),
    warn: (event: string, fields?: OperationalLogFields) => logger.warn(event, fields),
    error: (event: string, fields?: OperationalLogFields) => logger.error(event, fields),
  });
}
