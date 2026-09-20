import type { CreateEmailResponseSuccess, EmailApiOptions } from "resend";
import { EmailConfigurationError, type EmailErrorCode, EmailSendError } from "../errors.ts";
import type {
  EmailMessage,
  EmailSenderKind,
  EmailSendResult,
  EmailTemplateId,
  EmailTransport,
} from "../transport.ts";
import { assertValidMessage } from "./message.ts";

/** The subset of `fetch` the transport uses, so tests can inject a fake provider. */
export type EmailFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Configured `from` values (`EMAIL_FROM_SECURITY`, `EMAIL_FROM_REMINDERS`, §16.2). */
export interface EmailSenders {
  readonly security: string;
  /** Required only where reminder email is sent (the worker, or the api when `DURABLE=false`). */
  readonly reminders?: string;
}

/**
 * A redacted transport log entry: ids, enums, codes and durations only. It never carries
 * addresses, subjects, bodies, OTPs, provider messages or credentials (§6.3).
 */
export interface EmailTransportLogEntry {
  readonly event: "email.sent" | "email.failed";
  readonly transport: "resend" | "log" | "capture";
  readonly sender: EmailSenderKind;
  readonly template: EmailTemplateId | null;
  readonly idempotencyKey: string;
  readonly providerId?: string;
  readonly status?: number;
  readonly code?: EmailErrorCode;
  readonly providerErrorName?: string;
  readonly retryAfterSeconds?: number;
  readonly durationMs: number;
}

export interface EmailTransportLogger {
  info(entry: EmailTransportLogEntry): void;
  warn(entry: EmailTransportLogEntry): void;
}

export interface ResendTransportOptions {
  readonly apiKey: string;
  readonly senders: EmailSenders;
  readonly fetch?: EmailFetch;
  /** Defaults to `https://api.resend.com`. */
  readonly baseUrl?: string;
  /** Per-request timeout; defaults to 15 seconds. */
  readonly timeoutMs?: number;
  readonly logger?: EmailTransportLogger;
  /** Clock for durations and HTTP-date `Retry-After` values. */
  readonly now?: () => number;
}

export const resendDefaultBaseUrl = "https://api.resend.com";

/** Header names the transport sends to Resend. */
export const resendHeaderNames = {
  authorization: "Authorization",
  contentType: "Content-Type",
  idempotencyKey: "Idempotency-Key",
  userAgent: "User-Agent",
} as const;

const senderPattern = /^(?:[^<>\r\n]{1,128} )?<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/;
const providerNamePattern = /^[a-z][a-z_]{0,63}$/;

function checkSender(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!senderPattern.test(value)) {
    throw new EmailConfigurationError(
      "email.not_configured",
      `${label} must be an address or "Name <address>"`,
    );
  }
  return value;
}

/** Seconds from a `Retry-After` header holding delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

interface MappedError {
  readonly code: EmailErrorCode;
  readonly retryable: boolean;
  readonly message: string;
}

/** Maps a Resend error response to a stable code (Resend error reference, research A1 and A5). */
export function mapResendError(status: number, providerErrorName: string | undefined): MappedError {
  if (status === 409) {
    if (providerErrorName === "concurrent_idempotent_requests") {
      return {
        code: "email.idempotency_in_flight",
        retryable: true,
        message: "Resend is still processing a request with this idempotency key",
      };
    }
    return {
      code: "email.idempotency_conflict",
      retryable: false,
      message: "Resend rejected a reused idempotency key with a different payload",
    };
  }
  if (status === 429) {
    if (
      providerErrorName === "daily_quota_exceeded" ||
      providerErrorName === "monthly_quota_exceeded"
    ) {
      return {
        code: "email.quota_exceeded",
        retryable: false,
        message: "Resend sending quota exceeded",
      };
    }
    return { code: "email.rate_limited", retryable: true, message: "Resend rate limit exceeded" };
  }
  if (status === 401 || status === 403) {
    return {
      code: "email.unauthorized",
      retryable: false,
      message: "Resend refused the API key or sending domain",
    };
  }
  if (status === 400 || status === 404 || status === 405 || status === 422 || status === 451) {
    return { code: "email.rejected", retryable: false, message: "Resend rejected the email" };
  }
  if (status >= 500) {
    return {
      code: "email.provider_unavailable",
      retryable: true,
      message: "Resend is unavailable",
    };
  }
  return {
    code: "email.rejected",
    retryable: false,
    message: "Resend returned an unexpected error status",
  };
}

async function readProviderErrorName(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "name" in body) {
      const name = (body as { name: unknown }).name;
      if (typeof name === "string" && providerNamePattern.test(name)) return name;
    }
  } catch {
    // Non-JSON error bodies carry nothing we would keep.
  }
  return undefined;
}

function isSuccessBody(body: unknown): body is CreateEmailResponseSuccess {
  return (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof (body as { id: unknown }).id === "string" &&
    (body as { id: string }).id.length > 0
  );
}

/**
 * Sends email through the Resend REST API (§12.3). Every send carries `Idempotency-Key`; errors are
 * mapped to stable codes with `retryable` and `Retry-After`. The transport never retries itself
 * (the outbox owns retries) and never logs addresses, subjects, bodies or provider messages.
 */
export function createResendEmailTransport(options: ResendTransportOptions): EmailTransport {
  if (options.apiKey.trim() === "") {
    throw new EmailConfigurationError("email.not_configured", "RESEND_API_KEY is required");
  }
  const senders = {
    security: checkSender(options.senders.security, "EMAIL_FROM_SECURITY"),
    reminders: checkSender(options.senders.reminders, "EMAIL_FROM_REMINDERS"),
  };
  const fetchImpl: EmailFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const baseUrl = (options.baseUrl ?? resendDefaultBaseUrl).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const logger = options.logger;

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      assertValidMessage(message);
      const from = senders[message.sender];
      if (from === undefined) {
        throw new EmailConfigurationError(
          "email.not_configured",
          `No from address is configured for ${message.sender} email`,
        );
      }
      const started = now();
      const base = {
        transport: "resend",
        sender: message.sender,
        template: message.template ?? null,
        idempotencyKey: message.idempotencyKey,
      } as const;

      const fail = (error: EmailSendError): never => {
        logger?.warn({
          ...base,
          event: "email.failed",
          code: error.code,
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.providerErrorName === undefined
            ? {}
            : { providerErrorName: error.providerErrorName }),
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
          durationMs: now() - started,
        });
        throw error;
      };

      const body: EmailApiOptions = {
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [
          { name: "sender", value: message.sender },
          ...(message.template === undefined
            ? []
            : [{ name: "template", value: message.template }]),
        ],
        ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
      };

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/emails`, {
          method: "POST",
          headers: {
            [resendHeaderNames.authorization]: `Bearer ${options.apiKey}`,
            [resendHeaderNames.contentType]: "application/json",
            [resendHeaderNames.idempotencyKey]: message.idempotencyKey,
            [resendHeaderNames.userAgent]: "symplist-email",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        return fail(
          new EmailSendError(
            "email.network_error",
            timedOut ? "Resend request timed out" : "Resend request failed before a response",
            { retryable: true },
          ),
        );
      }

      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), now());
      if (!response.ok) {
        const providerErrorName = await readProviderErrorName(response);
        const mapped = mapResendError(response.status, providerErrorName);
        return fail(
          new EmailSendError(mapped.code, mapped.message, {
            status: response.status,
            retryable: mapped.retryable,
            ...(providerErrorName === undefined ? {} : { providerErrorName }),
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
          }),
        );
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      if (!isSuccessBody(parsed)) {
        // The provider may have accepted the email; the same idempotency key makes a retry safe.
        return fail(
          new EmailSendError("email.invalid_response", "Resend returned an unreadable response", {
            status: response.status,
            retryable: true,
          }),
        );
      }
      logger?.info({
        ...base,
        event: "email.sent",
        providerId: parsed.id,
        status: response.status,
        durationMs: now() - started,
      });
      return { providerId: parsed.id };
    },
  };
}
