import { logger as triggerLogger } from "@trigger.dev/sdk";

/**
 * The only way worker code logs (§8.3). Events are stable dotted codes and fields must match the
 * allowlisted schema: ids (`id`, `*Id`), stable codes (`code`, `*Code`, `status`, `reason`, `kind`,
 * `state`, `mode`, `executor`, `runtime`, `lane`, `task`),
 * durations (`*Ms`) and counts (`count`, `*Count`, `attempt`, `seq`, `*Bytes`, `generation`,
 * `httpStatus`), plus `is*`/`has*` flags. Anything
 * else is dropped before it reaches Trigger's logger and counted in `redactedFields`.
 */
export interface WorkerLogSink {
  info(message: string, properties?: Record<string, unknown>): void;
  warn(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

export type WorkerLogValue = string | number | boolean | null;

export interface WorkerLogger {
  info(event: string, fields?: Readonly<Record<string, WorkerLogValue>>): void;
  warn(event: string, fields?: Readonly<Record<string, WorkerLogValue>>): void;
  error(event: string, fields?: Readonly<Record<string, WorkerLogValue>>): void;
}

const stableCode = /^[a-z][a-z0-9_]*(?:[.-][a-z][a-z0-9_]*)*$/;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Provider ids: Trigger runs, batches and schedules, Composio accounts, Resend messages. */
const providerId = /^(?:run|batch|sched|ca|msg)_[A-Za-z0-9]{1,64}$/;
const fieldName = /^[a-z][A-Za-z0-9]{0,39}$/;

type FieldKind = "id" | "code" | "duration" | "count" | "flag";

function kindOf(name: string): FieldKind | null {
  if (!fieldName.test(name)) return null;
  if (name === "id" || name.endsWith("Id")) return "id";
  if (
    name === "code" ||
    name.endsWith("Code") ||
    ["status", "reason", "kind", "state", "mode", "executor", "runtime", "lane", "task"].includes(
      name,
    )
  ) {
    return "code";
  }
  if (name.endsWith("Ms")) return "duration";
  if (
    name === "count" ||
    name.endsWith("Count") ||
    name.endsWith("Bytes") ||
    ["attempt", "seq", "generation", "httpStatus"].includes(name)
  ) {
    return "count";
  }
  if (name.startsWith("is") || name.startsWith("has")) return "flag";
  return null;
}

function allowed(kind: FieldKind, value: WorkerLogValue): boolean {
  if (value === null) return true;
  switch (kind) {
    case "id":
      return typeof value === "string" && (uuidV7.test(value) || providerId.test(value));
    case "code":
      return typeof value === "string" && value.length <= 64 && stableCode.test(value);
    case "duration":
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "flag":
      return typeof value === "boolean";
  }
}

/** Keeps only allowlisted fields; returns them with the number of fields dropped. */
export function redactLogFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): Record<string, WorkerLogValue> {
  const kept: Record<string, WorkerLogValue> = {};
  let redacted = 0;
  for (const [name, value] of Object.entries(fields ?? {})) {
    const kind = kindOf(name);
    if (
      kind &&
      (value === null || ["string", "number", "boolean"].includes(typeof value)) &&
      allowed(kind, value as WorkerLogValue)
    ) {
      kept[name] = value as WorkerLogValue;
    } else {
      redacted += 1;
    }
  }
  if (redacted > 0) kept.redactedFields = redacted;
  return kept;
}

/** Creates the redacting logger over a sink (Trigger's `logger` by default). */
export function createWorkerLogger(sink: WorkerLogSink = triggerLogger): WorkerLogger {
  const emit =
    (level: "info" | "warn" | "error") =>
    (event: string, fields?: Readonly<Record<string, WorkerLogValue>>) => {
      const safeEvent =
        typeof event === "string" && event.length <= 64 && stableCode.test(event)
          ? event
          : "log.redacted_event";
      sink[level](safeEvent, redactLogFields(fields));
    };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}
