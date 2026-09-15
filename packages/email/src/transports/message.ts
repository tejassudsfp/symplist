import { EmailValidationError } from "../errors.ts";
import type { EmailMessage } from "../transport.ts";

const addressPattern = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/;
const headerName = /^[A-Za-z0-9-]{1,64}$/;
/** Headers the transport or provider owns; a message may not override them. */
const reservedHeaders = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "sender",
  "content-type",
  "content-transfer-encoding",
  "mime-version",
  "idempotency-key",
]);

function invalid(message: string): EmailValidationError {
  return new EmailValidationError("email.invalid_message", message);
}

/**
 * Checks a message before any transport touches it. Errors name the failing field only, never its
 * value, so addresses and content cannot reach logs through an error.
 */
export function assertValidMessage(message: EmailMessage): void {
  if (message.to.length > 320 || !addressPattern.test(message.to)) {
    throw invalid("to must be a single email address");
  }
  if (message.subject.trim() === "" || message.subject.length > 998) {
    throw invalid("subject must be 1-998 characters");
  }
  if (/[\r\n]/.test(message.subject)) {
    throw invalid("subject must be a single line");
  }
  if (message.html.trim() === "") throw invalid("html is required");
  if (message.text.trim() === "") throw invalid("text is required");
  if (message.sender !== "security" && message.sender !== "reminders") {
    throw invalid("sender must be security or reminders");
  }
  const key = message.idempotencyKey;
  if (key.length < 1 || key.length > 256 || !/^[\x21-\x7e]+$/.test(key)) {
    throw invalid("idempotencyKey must be 1-256 visible ASCII characters");
  }
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!headerName.test(name) || reservedHeaders.has(name.toLowerCase())) {
      throw invalid("headers contain a reserved or malformed header name");
    }
    if (/[\r\n]/.test(value)) {
      throw invalid("header values must be single lines");
    }
  }
  if (message.otp !== undefined && !/^\d{4,10}$/.test(message.otp)) {
    throw invalid("otp must be 4-10 digits");
  }
}

/** `m…@example.com`: enough to tell test inboxes apart in development logs, never the full address. */
export function redactAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "[redacted]";
  return `${address.slice(0, 1)}…@${address.slice(at + 1)}`;
}
