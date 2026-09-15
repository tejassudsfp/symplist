import type {
  EmailMessage,
  EmailSendResult,
  EmailTemplateId,
  EmailTransport,
} from "../transport.ts";
import { assertValidMessage } from "./message.ts";

/** An in-memory transport for tests: records every send and mimics provider idempotency. */
export interface CaptureEmailTransport extends EmailTransport {
  /** Every accepted send attempt, in order, including idempotent repeats. */
  readonly messages: readonly EmailMessage[];
  /** One message per idempotency key: what a recipient would receive. */
  delivered(): readonly EmailMessage[];
  last(): EmailMessage | undefined;
  byTemplate(template: EmailTemplateId): readonly EmailMessage[];
  /** Makes the next send reject with `error` without recording the message. */
  failNextWith(error: Error): void;
  clear(): void;
}

export function createCaptureEmailTransport(): CaptureEmailTransport {
  const messages: EmailMessage[] = [];
  const providerIds = new Map<string, string>();
  const delivered = new Map<string, EmailMessage>();
  const pendingFailures: Error[] = [];
  let sequence = 0;

  return {
    messages,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      assertValidMessage(message);
      const failure = pendingFailures.shift();
      if (failure !== undefined) throw failure;
      messages.push(message);
      const existing = providerIds.get(message.idempotencyKey);
      if (existing !== undefined) return { providerId: existing };
      sequence += 1;
      const providerId = `capture_${sequence}`;
      providerIds.set(message.idempotencyKey, providerId);
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
