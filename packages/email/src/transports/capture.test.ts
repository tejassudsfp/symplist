import { describe, expect, it } from "vitest";
import { EmailSendError, EmailValidationError } from "../errors.ts";
import type { EmailMessage } from "../transport.ts";
import { createCaptureEmailTransport } from "./capture.ts";
import { redactAddress } from "./message.ts";

const message: EmailMessage = {
  to: "maya@example.com",
  subject: "You have a task reminder",
  html: "<p>Reminder</p>",
  text: "Reminder",
  sender: "reminders",
  idempotencyKey: "reminder/0192f0a0-0000-7000-8000-000000000301/email",
  template: "reminder",
};

describe("capture transport", () => {
  it("records every attempt and deduplicates deliveries by idempotency key", async () => {
    const transport = createCaptureEmailTransport();
    const first = await transport.send(message);
    const repeat = await transport.send(message);
    const other = await transport.send({ ...message, idempotencyKey: "reminder/other/email" });

    expect(first).toEqual({ providerId: "capture_1" });
    expect(repeat).toEqual(first);
    expect(other).toEqual({ providerId: "capture_2" });
    expect(transport.messages).toHaveLength(3);
    expect(transport.delivered()).toHaveLength(2);
    expect(transport.last()?.idempotencyKey).toBe("reminder/other/email");
    expect(transport.byTemplate("reminder")).toHaveLength(3);
    expect(transport.byTemplate("otp_sign_in")).toEqual([]);
  });

  it("fails the next send on request without recording it", async () => {
    const transport = createCaptureEmailTransport();
    const failure = new EmailSendError("email.rate_limited", "Resend rate limit exceeded", {
      retryable: true,
      retryAfterSeconds: 1,
    });
    transport.failNextWith(failure);
    await expect(transport.send(message)).rejects.toBe(failure);
    expect(transport.messages).toEqual([]);
    await expect(transport.send(message)).resolves.toEqual({ providerId: "capture_1" });
  });

  it("validates messages like the real transports", async () => {
    const transport = createCaptureEmailTransport();
    await expect(transport.send({ ...message, text: "" })).rejects.toBeInstanceOf(
      EmailValidationError,
    );
  });

  it("clears all state", async () => {
    const transport = createCaptureEmailTransport();
    await transport.send(message);
    transport.failNextWith(new Error("pending"));
    transport.clear();
    expect(transport.messages).toEqual([]);
    await expect(transport.send(message)).resolves.toEqual({ providerId: "capture_1" });
  });
});

describe("redactAddress", () => {
  it("keeps only the first character and the domain", () => {
    expect(redactAddress("maya@example.com")).toBe("m…@example.com");
    expect(redactAddress("not-an-address")).toBe("[redacted]");
    expect(redactAddress("@example.com")).toBe("[redacted]");
  });
});
