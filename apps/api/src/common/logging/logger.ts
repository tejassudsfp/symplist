import { Inject, Injectable, type LoggerService, Optional } from "@nestjs/common";
import { CLOCK, type Clock, systemClock } from "../clock.ts";
import { currentRequestState } from "../request-context.ts";
import {
  isLogEventName,
  type LogFields,
  type LogValue,
  REDACTED,
  sanitizeLogFields,
} from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Where structured log lines go: stdout in production, an in-memory array in tests. */
export interface LogSink {
  write(line: string): void;
}

/** Injection token for the {@link LogSink}. */
export const LOG_SINK = "symplist:LOG_SINK";

/** Writes each line to standard output. */
export const stdoutLogSink: LogSink = Object.freeze({
  write: (line: string) => {
    process.stdout.write(`${line}\n`);
  },
});

const levelRank: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Injection token for the lowest level written; defaults to `info`. */
export const LOG_LEVEL = "symplist:LOG_LEVEL";

/**
 * The api's structured JSON logger (§6.3). Every line carries a timestamp, level, a stable event
 * code and, inside a request, the request id, route template, user id and session id. Fields are
 * sanitized by shape (`redact.ts`), so bodies, tokens, OTPs, passwords, prompts and document text
 * cannot reach the output. Errors are recorded by name and stable code only.
 */
@Injectable()
export class AppLogger {
  private readonly sink: LogSink;
  private readonly clock: Clock;
  private readonly minimum: number;

  constructor(
    @Inject(LOG_SINK) sink: LogSink,
    @Optional() @Inject(CLOCK) clock?: Clock,
    @Optional() @Inject(LOG_LEVEL) level?: LogLevel,
  ) {
    this.sink = sink;
    this.clock = clock ?? systemClock;
    this.minimum = levelRank[level ?? "info"];
  }

  debug(event: string, fields?: LogFields): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write("error", event, fields);
  }

  /** Writes one line; `extra` is trusted framework output that bypasses sanitization. */
  write(
    level: LogLevel,
    event: string,
    fields?: LogFields,
    extra?: Readonly<Record<string, LogValue>>,
  ): void {
    if (levelRank[level] < this.minimum) return;
    const state = currentRequestState();
    const line: Record<string, LogValue> = {
      ts: new Date(this.clock.now()).toISOString(),
      level,
      event: isLogEventName(event) ? event : "log.invalid_event",
    };
    if (state) {
      line.requestId = state.requestId;
      if (state.route) line.route = state.route;
      if (state.session) {
        line.userId = state.session.userId;
        line.sessionId = state.session.sessionId;
      }
    }
    for (const [key, value] of Object.entries(sanitizeLogFields(fields))) {
      if (!(key in line)) line[key] = value;
    }
    if (extra) Object.assign(line, extra);
    try {
      this.sink.write(JSON.stringify(line));
    } catch {
      // Logging never breaks a request.
    }
  }
}

/**
 * Nest framework contexts whose messages are fixed framework text (module and route registration),
 * so they are kept. Messages from every other context are redacted.
 */
const trustedFrameworkContexts: ReadonlySet<string> = new Set([
  "NestFactory",
  "InstanceLoader",
  "RoutesResolver",
  "RouterExplorer",
  "NestApplication",
  "WebSocketsController",
]);

function frameworkMessage(context: unknown, message: unknown): LogValue {
  if (
    typeof context === "string" &&
    trustedFrameworkContexts.has(context) &&
    typeof message === "string" &&
    message.length <= 300 &&
    !/[\r\n]/.test(message)
  ) {
    return message;
  }
  return REDACTED;
}

function contextOf(params: readonly unknown[]): string | undefined {
  const last = params.at(-1);
  return typeof last === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(last) ? last : undefined;
}

/**
 * Routes Nest's own logging into {@link AppLogger}. Framework errors are recorded by context only;
 * their messages and stacks never reach the output.
 */
@Injectable()
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.frame("info", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.frame("warn", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.frame("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.frame("debug", message, params);
  }

  error(_message: unknown, ...params: unknown[]): void {
    const context = contextOf(params);
    this.logger.write("error", "nest.error", context ? { context } : undefined);
  }

  fatal(_message: unknown, ...params: unknown[]): void {
    const context = contextOf(params);
    this.logger.write("error", "nest.fatal", context ? { context } : undefined);
  }

  private frame(level: LogLevel, message: unknown, params: readonly unknown[]): void {
    const context = contextOf(params);
    this.logger.write(level, "nest.log", context ? { context } : undefined, {
      message: frameworkMessage(context, message),
    });
  }
}
