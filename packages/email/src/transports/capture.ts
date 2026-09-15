import { EmailSendError } from "../errors.ts";
import type {
  EmailMessage,
  EmailSendResult,
  EmailTemplateId,
  EmailTransport,
} from "../transport.ts";
import { assertValidMessage } from "./message.ts";

/**
 * An in-memory transport for tests: records every send and mimics Resend idempotency. A repeated key
 * with the same message returns the first provider id; the same key with a different message fails
 * with `email.idempotency_conflict`, as Resend's 409 `invalid_idempotent_request` does.
 */
export interface CaptureEmailTransport extends EmailTransport {
  /** Every accepted send attempt, in order, including idempotent repeats (not conflicts). */
  readonly messages: readonly EmailMessage[];
  /** One message per idempotency key: what a recipient would receive. */
  delivered(): readonly EmailMessage[];
  last(): EmailMessage | undefined;
  byTemplate(template: EmailTemplateId): readonly EmailMessage[];
  /** Makes the next send reject with `error` without recording the message. */
  failNextWith(error: Error): void;
  clear(): void;
}

/** Everything Resend would compare for an idempotent repeat: the message without its key. */
function fingerprintOf(message: EmailMessage): string {
  const headers = Object.entries(message.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    message.to,
    message.sender,
    message.subject,
    message.html,
    message.text,
    message.template ?? null,
    headers,
  ]);
}

export function createCaptureEmailTransport(): CaptureEmailTransport {
  const messages: EmailMessage[] = [];
  const providerIds = new Map<
    string,
    { readonly providerId: string; readonly fingerprint: string }
  >();
  const delivered = new Map<string, EmailMessage>();
  const pendingFailures: Error[] = [];
  let sequence = 0;

  return {
    messages,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      assertValidMessage(message);
      const failure = pendingFailures.shift();
      if (failure !== undefined) throw failure;
      const fingerprint = fingerprintOf(message);
      const existing = providerIds.get(message.idempotencyKey);
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        throw new EmailSendError(
          "email.idempotency_conflict",
          "Resend rejected a reused idempotency key with a different payload",
          { status: 409, providerErrorName: "invalid_idempotent_request", retryable: false },
        );
      }
      messages.push(message);
      if (existing !== undefined) return { providerId: existing.providerId };
      sequence += 1;
      const providerId = `capture_${sequence}`;
      providerIds.set(message.idempotencyKey, { providerId, fingerprint });
      delivered.set(message.idempotencyKey, message);
      return { providerId };
    },
    delivered: () => [...delivered.values()],
    last: () => messages.at(-1),
    byTemplate: (template) => messages.filter((message) => message.template === template),
    failNextWith(error) {
      pendingFailures.push(error);
    },
    clear() {
      messages.length = 0;
      providerIds.clear();
      delivered.clear();
      pendingFailures.length = 0;
      sequence = 0;
    },
  };
}
