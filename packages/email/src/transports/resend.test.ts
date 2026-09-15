import { describe, expect, it } from "vitest";
import { EmailConfigurationError, EmailSendError, EmailValidationError } from "../errors.ts";
import type { EmailMessage } from "../transport.ts";
import {
  createResendEmailTransport,
  type EmailFetch,
  type EmailTransportLogEntry,
  mapResendError,
  parseRetryAfter,
  type ResendTransportOptions,
} from "./resend.ts";

// A throwaway key generated per run; never a real credential.
const apiKey = `re_test_${crypto.randomUUID()}`;
const now = Date.UTC(2026, 8, 15, 12, 0, 0);

const message: EmailMessage = {
  to: "maya@example.com",
  subject: "Your symplist sign-in code",
  html: "<p>Enter this code: 482913</p>",
  text: "Enter this code: 482913",
  sender: "security",
  idempotencyKey: "otp/login/0192f0a0-0000-7000-8000-000000000001",
  template: "otp_sign_in",
  otp: "482913",
};

interface RecordedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | null | undefined;
}

function scriptedFetch(responses: Array<Response | Error>): {
  fetch: EmailFetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: EmailFetch = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      signal: init.signal,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, requests };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function transport(fetch: EmailFetch, overrides: Partial<ResendTransportOptions> = {}) {
  const logs: EmailTransportLogEntry[] = [];
  const instance = createResendEmailTransport({
    apiKey,
    senders: {
      security: "symplist <security@mail.symplist.example>",
      reminders: "symplist reminders <reminders@mail.symplist.example>",
    },
    fetch,
    now: () => now,
    logger: { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry) },
    ...overrides,
  });
  return { instance, logs };
}

async function sendError(promise: Promise<unknown>): Promise<EmailSendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmailSendError);
    return error as EmailSendError;
  }
  throw new Error("expected the send to fail");
}

/** Everything a log line or error could leak. */
const sensitive = [message.to, message.subject, message.html, message.text, "482913", apiKey];

function expectNoLeaks(value: unknown) {
  const serialized = JSON.stringify(value, (_key, inner) =>
    inner instanceof Error ? { name: inner.name, message: inner.message } : inner,
  );
  for (const secret of sensitive) expect(serialized).not.toContain(secret);
}

describe("Resend transport", () => {
  it("posts one email with the idempotency key, auth and JSON headers", async () => {
    const { fetch, requests } = scriptedFetch([json(200, { id: "re_msg_1" })]);
    const { instance, logs } = transport(fetch);

    await expect(instance.send(message)).resolves.toEqual({ providerId: "re_msg_1" });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://api.resend.com/emails");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Idempotency-Key")).toBe(message.idempotencyKey);
    expect(request?.headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.body).toEqual({
      from: "symplist <security@mail.symplist.example>",
      to: ["maya@example.com"],
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: [
        { name: "sender", value: "security" },
        { name: "template", value: "otp_sign_in" },
      ],
    });
    // The OTP field is for the log transport only and is never sent as its own property.
    expect(Object.keys(request?.body ?? {})).not.toContain("otp");
    expect(logs).toEqual([
      {
        event: "email.sent",
        transport: "resend",
        sender: "security",
        template: "otp_sign_in",
        idempotencyKey: message.idempotencyKey,
        providerId: "re_msg_1",
        status: 200,
        durationMs: 0,
      },
    ]);
    expectNoLeaks(logs);
  });

  it("uses the reminders sender and forwards custom headers", async () => {
    const { fetch, requests } = scriptedFetch([json(200, { id: "re_msg_2" })]);
    const { instance } = transport(fetch);
    await instance.send({
      ...message,
      sender: "reminders",
      template: "reminder",
      otp: undefined,
      idempotencyKey: "reminder/0192f0a0-0000-7000-8000-000000000301/email",
      headers: {
        "List-Unsubscribe": "<https://api.symplist.example/v1/reminders/unsubscribe?token=x>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    expect(requests[0]?.body.from).toBe("symplist reminders <reminders@mail.symplist.example>");
    expect(requests[0]?.body.headers).toEqual({
      "List-Unsubscribe": "<https://api.symplist.example/v1/reminders/unsubscribe?token=x>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("refuses reminder email when no reminders sender is configured", async () => {
    const { fetch, requests } = scriptedFetch([]);
    const { instance } = transport(fetch, { senders: { security: "security@symplist.example" } });
    await expect(instance.send({ ...message, sender: "reminders" })).rejects.toBeInstanceOf(
      EmailConfigurationError,
    );
    expect(requests).toHaveLength(0);
  });

  it.each([
    [
      "409 invalid_idempotent_request",
      json(409, {
        statusCode: 409,
        name: "invalid_idempotent_request",
        message: "maya@example.com",
      }),
      { code: "email.idempotency_conflict", retryable: false, status: 409 },
    ],
    [
      "409 concurrent_idempotent_requests",
      json(409, { statusCode: 409, name: "concurrent_idempotent_requests", message: "busy" }),
      { code: "email.idempotency_in_flight", retryable: true, status: 409 },
    ],
    [
      "422 validation_error",
      json(422, {
        statusCode: 422,
        name: "validation_error",
        message: "Invalid `to` field: maya@example.com",
      }),
      { code: "email.rejected", retryable: false, status: 422 },
    ],
    [
      "429 rate_limit_exceeded with Retry-After seconds",
      json(
        429,
        { statusCode: 429, name: "rate_limit_exceeded", message: "slow down" },
        {
          "retry-after": "2",
        },
      ),
      { code: "email.rate_limited", retryable: true, status: 429, retryAfterSeconds: 2 },
    ],
    [
      "429 daily_quota_exceeded",
      json(
        429,
        { statusCode: 429, name: "daily_quota_exceeded", message: "quota" },
        {
          "retry-after": "3600",
        },
      ),
      { code: "email.quota_exceeded", retryable: false, status: 429, retryAfterSeconds: 3600 },
    ],
    [
      "401 missing_api_key",
      json(401, { statusCode: 401, name: "missing_api_key", message: "no key" }),
      { code: "email.unauthorized", retryable: false, status: 401 },
    ],
    [
      "403 invalid_api_key",
      json(403, { statusCode: 403, name: "invalid_api_key", message: "bad key" }),
      { code: "email.unauthorized", retryable: false, status: 403 },
    ],
    [
      "500 with a non-JSON body",
      new Response("<html>oops maya@example.com</html>", { status: 500 }),
      { code: "email.provider_unavailable", retryable: true, status: 500 },
    ],
  ] as const)("maps %s to a stable code", async (_label, response, expected) => {
    const { fetch, requests } = scriptedFetch([response]);
    const { instance, logs } = transport(fetch);
    const error = await sendError(instance.send(message));
    expect(error.code).toBe(expected.code);
    expect(error.retryable).toBe(expected.retryable);
    expect(error.status).toBe(expected.status);
    expect(error.retryAfterSeconds).toBe(
      "retryAfterSeconds" in expected ? expected.retryAfterSeconds : undefined,
    );
    // No transport-level retries: the outbox decides.
    expect(requests).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.event).toBe("email.failed");
    expect(logs[0]?.code).toBe(expected.code);
    expectNoLeaks({ logs, error, message: error.message, stack: error.stack });
  });

  it("keeps the provider error name but never the provider message", async () => {
    const { fetch } = scriptedFetch([
      json(422, {
        statusCode: 422,
        name: "invalid_from_address",
        message: "bad from maya@example.com",
      }),
    ]);
    const { instance } = transport(fetch);
    const error = await sendError(instance.send(message));
    expect(error.providerErrorName).toBe("invalid_from_address");
    expect(error.message).not.toContain("maya@example.com");
  });

  it("drops provider error names that are not enumerated identifiers", async () => {
    const { fetch } = scriptedFetch([
      json(422, { statusCode: 422, name: "maya@example.com", message: "x" }),
    ]);
    const { instance } = transport(fetch);
    const error = await sendError(instance.send(message));
    expect(error.providerErrorName).toBeUndefined();
  });

  it("parses an HTTP-date Retry-After against the clock", async () => {
    const retryAt = new Date(now + 90_000).toUTCString();
    const { fetch } = scriptedFetch([
      json(
        429,
        { statusCode: 429, name: "rate_limit_exceeded", message: "x" },
        {
          "retry-after": retryAt,
        },
      ),
    ]);
    const { instance } = transport(fetch);
    const error = await sendError(instance.send(message));
    expect(error.retryAfterSeconds).toBe(90);
  });

  it("maps network failures and timeouts to a retryable network error", async () => {
    const network = scriptedFetch([new TypeError("fetch failed: maya@example.com")]);
    const networkError = await sendError(transport(network.fetch).instance.send(message));
    expect(networkError.code).toBe("email.network_error");
    expect(networkError.retryable).toBe(true);
    expectNoLeaks({ message: networkError.message });

    const timeout = scriptedFetch([new DOMException("The operation timed out", "TimeoutError")]);
    const timeoutError = await sendError(transport(timeout.fetch).instance.send(message));
    expect(timeoutError.code).toBe("email.network_error");
    expect(timeoutError.message).toBe("Resend request timed out");
  });

  it("aborts a request that exceeds the timeout", async () => {
    const hanging: EmailFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { instance } = transport(hanging, { timeoutMs: 5 });
    const error = await sendError(instance.send(message));
    expect(error.code).toBe("email.network_error");
  });

  it("treats an unreadable success body as a retryable invalid response", async () => {
    const { fetch } = scriptedFetch([new Response("not json", { status: 200 })]);
    const error = await sendError(transport(fetch).instance.send(message));
    expect(error.code).toBe("email.invalid_response");
    expect(error.retryable).toBe(true);
  });

  it.each([
    ["two recipients", { to: "a@example.com, b@example.com" }],
    ["a display-name address", { to: "Maya <maya@example.com>" }],
    ["a multi-line subject", { subject: "Hello\r\nBcc: x@example.com" }],
    ["an empty text body", { text: " " }],
    ["an empty html body", { html: "" }],
    ["an overlong idempotency key", { idempotencyKey: "k".repeat(257) }],
    ["an empty idempotency key", { idempotencyKey: "" }],
    ["a reserved header", { headers: { Bcc: "x@example.com" } }],
    ["a header injection", { headers: { "X-Note": "a\r\nBcc: x@example.com" } }],
    ["a non-digit otp", { otp: "abc" }],
  ] as Array<[string, Partial<EmailMessage>]>)(
    "rejects %s before calling Resend",
    async (_label, override) => {
      const { fetch, requests } = scriptedFetch([]);
      const { instance } = transport(fetch);
      await expect(instance.send({ ...message, ...override })).rejects.toBeInstanceOf(
        EmailValidationError,
      );
      expect(requests).toHaveLength(0);
    },
  );

  it("validates configuration at construction", () => {
    const { fetch } = scriptedFetch([]);
    expect(() => transport(fetch, { apiKey: " " })).toThrow(EmailConfigurationError);
    expect(() => transport(fetch, { senders: { security: "not an address" } })).toThrow(
      EmailConfigurationError,
    );
    expect(() =>
      transport(fetch, { senders: { security: "a@example.com\r\nBcc: b@example.com" } }),
    ).toThrow(EmailConfigurationError);
  });

  it("honours a custom base URL", async () => {
    const { fetch, requests } = scriptedFetch([json(200, { id: "re_msg_3" })]);
    const { instance } = transport(fetch, { baseUrl: "https://resend.proxy.example/" });
    await instance.send(message);
    expect(requests[0]?.url).toBe("https://resend.proxy.example/emails");
  });
});

describe("Retry-After parsing and error mapping", () => {
  it("parses delta seconds, HTTP dates and garbage", () => {
    expect(parseRetryAfter("7", now)).toBe(7);
    expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("maps statuses outside the documented set conservatively", () => {
    expect(mapResendError(418, undefined)).toMatchObject({
      code: "email.rejected",
      retryable: false,
    });
    expect(mapResendError(503, undefined)).toMatchObject({
      code: "email.provider_unavailable",
      retryable: true,
    });
    expect(mapResendError(409, undefined)).toMatchObject({ code: "email.idempotency_conflict" });
  });
});
