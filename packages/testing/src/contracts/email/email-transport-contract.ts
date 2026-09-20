import {
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
  EmailValidationError,
} from "@symplist/email";
import { describe, expect, it } from "vitest";

/**
 * The email transport contract (§17): every `EmailTransport` (Resend over the fake Resend API, the
 * development log transport and the test capture transport) validates a message before anything leaves
 * the process, never mutates it, keeps addresses, subjects, bodies and codes out of its logs and
 * errors, and returns the result shape its kind promises. Provider-backed transports also honor the
 * idempotency key the way Resend does: an exact retry is one delivery with the same provider id, and
 * the same key with a different message is `email.idempotency_conflict`.
 */
export interface EmailTransportContractTarget {
  readonly transport: EmailTransport;
  /**
   * `provider`: returns a provider message id and deduplicates by idempotency key (Resend, capture).
   * `log`: prints a redacted summary (with the code of an OTP email only) and returns no id.
   */
  readonly kind: "provider" | "log";
  /** How many sends reached the delivery side: emails the provider accepted, or lines printed. */
  readonly deliveries: () => number;
  /** Everything the transport logged or printed, serialized, for the leak checks. */
  readonly logs: () => readonly string[];
}

const address = "maya.contract@example.com";
const otpCode = "604219";

function otpMessage(suffix: string): EmailMessage {
  return {
    to: address,
    subject: "Your symplist sign-in code",
    html: `<p>Private html body ${suffix}</p>`,
    text: `Private text body ${suffix}`,
    sender: "security",
    idempotencyKey: `otp/login/0192f0a0-0000-7000-8000-${suffix.padStart(12, "0")}`,
    template: "otp_sign_in",
    otp: otpCode,
  };
}

function reminderMessage(suffix: string): EmailMessage {
  return {
    to: address,
    subject: "Reminder: Refresh the private portfolio",
    html: `<p>Refresh the private portfolio ${suffix}</p>`,
    text: `Refresh the private portfolio ${suffix}`,
    sender: "reminders",
    idempotencyKey: `reminder/0192f0a0-0000-7000-8000-${suffix.padStart(12, "0")}/email`,
    template: "reminder",
    headers: { "X-Entity-Ref-ID": `ref-${suffix}` },
  };
}

function deepFreeze<T extends object>(value: T): T {
  for (const inner of Object.values(value)) {
    if (typeof inner === "object" && inner !== null) deepFreeze(inner);
  }
  return Object.freeze(value);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the send to fail");
}

function serializeError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  return JSON.stringify({ ...error, name: error.name, message: error.message });
}

/** Content a transport must never write to its logs or errors (the log transport may print the OTP). */
function forbiddenContent(target: EmailTransportContractTarget, message: EmailMessage): string[] {
  return [
    message.to,
    message.subject,
    message.html,
    message.text,
    ...(target.kind === "log" || message.otp === undefined ? [] : [message.otp]),
  ];
}

function expectNoContent(haystack: string, forbidden: readonly string[]): void {
  // Blank values (the empty bodies of invalid messages) are not content and would match anything.
  for (const value of forbidden.filter((entry) => entry.trim() !== "")) {
    expect(haystack).not.toContain(value);
  }
}

export function describeEmailTransportContract(
  name: string,
  createTarget: () => EmailTransportContractTarget | Promise<EmailTransportContractTarget>,
): void {
  describe(`email transport contract: ${name} (§17)`, () => {
    it("sends security and reminder email and returns the result its kind promises", async () => {
      const target = await createTarget();
      const results: EmailSendResult[] = [
        await target.transport.send(otpMessage("1")),
        await target.transport.send(reminderMessage("2")),
      ];
      expect(target.deliveries()).toBe(2);
      for (const result of results) {
        if (target.kind === "provider") {
          expect(result.providerId).toEqual(expect.any(String));
          expect(result.providerId).not.toBe("");
        } else {
          expect(result).toEqual({ providerId: null });
        }
      }
      if (target.kind === "provider")
        expect(results[0]?.providerId).not.toBe(results[1]?.providerId);
    });

    it("never mutates the message it sends", async () => {
      const target = await createTarget();
      const frozen = deepFreeze(reminderMessage("3"));
      const copy = structuredClone(frozen);
      await target.transport.send(frozen);
      expect(frozen).toEqual(copy);
    });

    it.each([
      ["a recipient that is not one address", { to: "maya@example.com, eve@example.com" }],
      ["a subject that injects a header line", { subject: "Hello\r\nBcc: eve@example.com" }],
      ["an empty plain-text version", { text: "   " }],
      ["an empty html version", { html: "" }],
      ["an unknown sender", { sender: "marketing" }],
      ["an idempotency key with spaces", { idempotencyKey: "otp login" }],
      ["a reserved header", { headers: { "Idempotency-Key": "other" } }],
      ["a header value that injects a line", { headers: { "X-Ref": "a\r\nBcc: eve@example.com" } }],
      ["a malformed OTP", { otp: "12ab" }],
    ] as const)(
      "rejects %s with email.invalid_message before delivering anything",
      async (_case, change) => {
        const target = await createTarget();
        const message = { ...otpMessage("4"), ...change } as EmailMessage;
        const error = await rejection(target.transport.send(message));
        expect(error).toBeInstanceOf(EmailValidationError);
        expect((error as EmailValidationError).code).toBe("email.invalid_message");
        expect(target.deliveries()).toBe(0);
        expectNoContent(serializeError(error), [
          ...forbiddenContent(target, message),
          "eve@example.com",
        ]);
      },
    );

    it("keeps addresses, subjects, bodies and codes out of logs and errors", async () => {
      const target = await createTarget();
      const otp = otpMessage("5");
      const reminder = reminderMessage("6");
      await target.transport.send(otp);
      await target.transport.send(reminder);
      const logs = target.logs().join("\n");
      expectNoContent(logs, forbiddenContent(target, otp));
      expectNoContent(logs, forbiddenContent(target, reminder));
      if (target.kind === "log") {
        // Development sign-in works without Resend: only an OTP email prints its code.
        expect(logs).toContain(otpCode);
        expect(target.logs().filter((line) => line.includes(otpCode))).toHaveLength(1);
      }
    });

    it("delivers an exact retry once with the same provider id (provider transports)", async () => {
      const target = await createTarget();
      const message = otpMessage("7");
      const first = await target.transport.send(message);
      const retry = await target.transport.send({ ...message });
      if (target.kind === "log") {
        // The log transport has no provider to deduplicate; each send prints one line.
        expect(target.deliveries()).toBe(2);
        return;
      }
      expect(retry.providerId).toBe(first.providerId);
      expect(target.deliveries()).toBe(1);
    });

    it("refuses the same idempotency key with a different message (provider transports)", async () => {
      const target = await createTarget();
      const message = reminderMessage("8");
      await target.transport.send(message);
      const changed = { ...message, text: `${message.text} changed`, html: `${message.html}!` };
      if (target.kind === "log") {
        await target.transport.send(changed);
        expect(target.deliveries()).toBe(2);
        return;
      }
      const error = await rejection(target.transport.send(changed));
      expect(error).toMatchObject({ code: "email.idempotency_conflict", retryable: false });
      expect(target.deliveries()).toBe(1);
      expectNoContent(serializeError(error), forbiddenContent(target, changed));
      expectNoContent(target.logs().join("\n"), forbiddenContent(target, changed));
    });
  });
}
