import { randomUUID } from "node:crypto";
import {
  createEmailRenderer,
  createResendEmailTransport,
  EmailSendError,
  emailIdempotencyKeys,
  toEmailMessage,
} from "@symplist/email";
import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.ts";
import { FakeResend } from "./resend.ts";

// A throwaway key generated per run; never a real credential.
const apiKey = `re_test_${randomUUID()}`;
const occurrenceId = "0192f0a0-0000-7000-8000-000000000301";

function setup(options: { requestsPerSecond?: number } = {}) {
  const clock = new FakeClock();
  const resend = new FakeResend({ apiKey, clock, ...options });
  const transport = createResendEmailTransport({
    apiKey,
    senders: {
      security: "symplist <security@mail.symplist.example>",
      reminders: "symplist <reminders@mail.symplist.example>",
    },
    fetch: resend.fetch,
    now: clock.nowFn,
  });
  return { clock, resend, transport };
}

async function reminderMessage(title = "Refresh my portfolio") {
  const renderer = createEmailRenderer({
    webOrigin: "https://app.symplist.example",
    apiOrigin: "https://api.symplist.example",
    accountHelpUrl: "https://symplist.example/help/account",
  });
  const rendered = await renderer.reminder({
    due: { kind: "timed", at: Date.UTC(2026, 8, 18, 17), timeZone: "America/Los_Angeles" },
    preview: { kind: "title", title },
    openTaskUrl: "https://app.symplist.example/now/0192f0a0-0000-7000-8000-000000000101",
    preferencesUrl: "https://app.symplist.example/settings/notifications",
  });
  return toEmailMessage(rendered, {
    to: "maya@example.com",
    idempotencyKey: emailIdempotencyKeys.reminder(occurrenceId),
  });
}

async function sendError(promise: Promise<unknown>): Promise<EmailSendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmailSendError);
    return error as EmailSendError;
  }
  throw new Error("expected failure");
}

describe("FakeResend with the real Resend transport", () => {
  it("accepts an email and records it with its idempotency key and tags", async () => {
    const { resend, transport } = setup();
    const message = await reminderMessage();
    const result = await transport.send(message);
    expect(result.providerId).toBe("00000000-0000-4000-8000-000000000001");
    expect(resend.emails).toHaveLength(1);
    expect(resend.emails[0]).toMatchObject({
      idempotencyKey: `reminder/${occurrenceId}/email`,
      from: "symplist <reminders@mail.symplist.example>",
      to: ["maya@example.com"],
      subject: "Reminder: Refresh my portfolio",
      tags: [
        { name: "sender", value: "reminders" },
        { name: "template", value: "reminder" },
      ],
    });
    expect(resend.requests[0]?.headers["idempotency-key"]).toBe(`reminder/${occurrenceId}/email`);
  });

  it("returns the same email for a retried send with the same key and payload", async () => {
    const { resend, transport } = setup();
    const message = await reminderMessage();
    const first = await transport.send(message);
    const retry = await transport.send(message);
    expect(retry.providerId).toBe(first.providerId);
    expect(resend.emails).toHaveLength(1);
    expect(resend.requests).toHaveLength(2);
  });

  it("rejects a reused key with a different payload, and treats an in-flight key as retryable", async () => {
    const { resend, transport } = setup();
    await transport.send(await reminderMessage());
    const conflict = await sendError(transport.send(await reminderMessage("Book a bike tune-up")));
    expect(conflict).toMatchObject({
      code: "email.idempotency_conflict",
      retryable: false,
      status: 409,
    });

    const other = { ...(await reminderMessage()), idempotencyKey: "reminder/other/email" };
    resend.holdKey(other.idempotencyKey);
    const inFlight = await sendError(transport.send(other));
    expect(inFlight).toMatchObject({ code: "email.idempotency_in_flight", retryable: true });
    resend.releaseKey(other.idempotencyKey);
    await expect(transport.send(other)).resolves.toMatchObject({ providerId: expect.any(String) });
  });

  it("forgets keys after 24 hours", async () => {
    const { clock, resend, transport } = setup();
    const message = await reminderMessage();
    const first = await transport.send(message);
    await clock.advance(24 * 60 * 60 * 1000 + 1);
    const later = await transport.send(message);
    expect(later.providerId).not.toBe(first.providerId);
    expect(resend.emails).toHaveLength(2);
  });

  it("enforces the per-second team rate limit with Retry-After", async () => {
    const { clock, resend, transport } = setup({ requestsPerSecond: 2 });
    const base = await reminderMessage();
    await transport.send({ ...base, idempotencyKey: "k1" });
    await transport.send({ ...base, idempotencyKey: "k2" });
    const limited = await sendError(transport.send({ ...base, idempotencyKey: "k3" }));
    expect(limited).toMatchObject({
      code: "email.rate_limited",
      retryable: true,
      retryAfterSeconds: 1,
    });
    expect(resend.requests.at(-1)?.status).toBe(429);
    await clock.advance(1000);
    await expect(transport.send({ ...base, idempotencyKey: "k3" })).resolves.toMatchObject({
      providerId: expect.any(String),
    });
  });

  it("refuses wrong or missing API keys", async () => {
    const { resend } = setup();
    const wrongKey = createResendEmailTransport({
      apiKey: `re_test_${randomUUID()}`,
      senders: {
        security: "security@mail.symplist.example",
        reminders: "reminders@mail.symplist.example",
      },
      fetch: resend.fetch,
    });
    expect(await sendError(wrongKey.send(await reminderMessage()))).toMatchObject({
      code: "email.unauthorized",
      status: 403,
    });
    const missing = await resend.fetch("https://api.resend.com/emails", {
      method: "POST",
      body: "{}",
    });
    expect(missing.status).toBe(401);
  });

  it("validates bodies, keys and endpoints", async () => {
    const { resend } = setup();
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      resend.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, ...headers },
        body: JSON.stringify(body),
      });
    expect((await post({ to: ["a@example.com"], subject: "s", text: "t" })).status).toBe(422);
    expect((await post({ from: "x@example.com", to: [], subject: "s", text: "t" })).status).toBe(
      422,
    );
    expect(
      (await post({ from: "x@example.com", to: ["a@example.com"], subject: "s" })).status,
    ).toBe(422);
    expect(
      (
        await post({
          from: "x@example.com",
          to: ["a@example.com"],
          subject: "s",
          text: "t",
          tags: [{ name: "bad tag", value: "v" }],
        })
      ).status,
    ).toBe(422);
    const tooLong = await post(
      { from: "x@example.com", to: ["a@example.com"], subject: "s", text: "t" },
      { "Idempotency-Key": "k".repeat(257) },
    );
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { name: string }).name).toBe("invalid_idempotency_key");
    expect(
      (
        await resend.fetch("https://api.resend.com/domains", {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        })
      ).status,
    ).toBe(404);
  });

  it("replays scripted failures, including network errors", async () => {
    const { resend, transport } = setup();
    const message = await reminderMessage();
    resend.failNext({
      status: 422,
      name: "invalid_from_address",
      message: "Invalid `from` field.",
    });
    resend.failNext({ status: 500, name: "internal_server_error" });
    resend.failNext("network_error");
    expect(await sendError(transport.send(message))).toMatchObject({
      code: "email.rejected",
      providerErrorName: "invalid_from_address",
    });
    expect(await sendError(transport.send(message))).toMatchObject({
      code: "email.provider_unavailable",
      retryable: true,
    });
    expect(await sendError(transport.send(message))).toMatchObject({ code: "email.network_error" });
    await expect(transport.send(message)).resolves.toMatchObject({
      providerId: expect.any(String),
    });
    expect(resend.requests.map((request) => request.status)).toEqual([
      422,
      500,
      "network_error",
      200,
    ]);
  });
});
