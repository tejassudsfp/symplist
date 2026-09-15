import { type Clock, FakeClock } from "./clock.ts";

/**
 * A fake of the Resend REST API as `fetch` (research A1, A5, §12.3): `POST /emails` with bearer auth,
 * request validation, `Idempotency-Key` semantics (same key and payload returns the same email for
 * 24 hours, a different payload is 409 `invalid_idempotent_request`, an in-flight key is 409
 * `concurrent_idempotent_requests`), the 10 requests per second team limit with `retry-after` and
 * `ratelimit-*` headers, and scripted failures. Accepted emails are kept for assertions.
 */

export interface FakeResendEmail {
  readonly id: string;
  readonly idempotencyKey: string | null;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string | undefined;
  readonly text: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly tags: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly createdAt: number;
}

export interface FakeResendRequest {
  readonly method: string;
  readonly url: string;
  /** Header names lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly status: number | "network_error";
}

export interface FakeResendFailure {
  readonly status: number;
  readonly name: string;
  readonly message?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeResendOptions {
  /** The API key the fake accepts; generate a throwaway value in tests. */
  readonly apiKey: string;
  readonly clock?: Clock;
  /** Team rate limit; defaults to Resend's 10 requests per second. */
  readonly requestsPerSecond?: number;
  readonly baseUrl?: string;
}

const idempotencyWindowMs = 24 * 60 * 60 * 1000;
const tagPattern = /^[A-Za-z0-9_-]{1,256}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorResponse(
  status: number,
  name: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ statusCode: status, name, message }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export class FakeResend {
  readonly clock: Clock;
  readonly requests: FakeResendRequest[] = [];
  readonly emails: FakeResendEmail[] = [];

  private readonly apiKey: string;
  private readonly requestsPerSecond: number;
  private readonly baseUrl: string;
  private readonly keys = new Map<
    string,
    { fingerprint: string; emailId: string; createdAt: number }
  >();
  private readonly inFlight = new Set<string>();
  private readonly failures: Array<FakeResendFailure | "network_error"> = [];
  private readonly recent: number[] = [];
  private sequence = 0;

  constructor(options: FakeResendOptions) {
    if (options.apiKey === "") throw new Error("FakeResend needs an API key to accept");
    this.apiKey = options.apiKey;
    this.clock = options.clock ?? new FakeClock();
    this.requestsPerSecond = options.requestsPerSecond ?? 10;
    this.baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  }

  /** Makes the next request fail with a scripted response or a network error. */
  failNext(failure: FakeResendFailure | "network_error"): void {
    this.failures.push(failure);
  }

  /** Marks an idempotency key as still being processed, as if a concurrent request held it. */
  holdKey(key: string): void {
    this.inFlight.add(key);
  }

  releaseKey(key: string): void {
    this.inFlight.delete(key);
  }

  /** The `fetch` function to inject into the Resend transport. */
  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (value, key) => {
        headers[key.toLowerCase()] = value;
      },
    );
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    let body: unknown;
    try {
      body = rawBody === undefined ? undefined : JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }

    const respond = (response: Response): Response => {
      this.requests.push({ method, url, headers, body, status: response.status });
      return response;
    };

    const failure = this.failures.shift();
    if (failure === "network_error") {
      this.requests.push({ method, url, headers, body, status: "network_error" });
      throw new TypeError("fetch failed");
    }
    if (failure !== undefined) {
      return respond(
        errorResponse(failure.status, failure.name, failure.message ?? failure.name, {
          ...failure.headers,
        }),
      );
    }

    if (url !== `${this.baseUrl}/emails` || method !== "POST") {
      return respond(errorResponse(404, "not_found", "The requested endpoint does not exist."));
    }
    const authorization = headers.authorization;
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
      return respond(
        errorResponse(401, "missing_api_key", "Missing API key in the authorization header."),
      );
    }
    if (authorization.slice("Bearer ".length) !== this.apiKey) {
      return respond(errorResponse(403, "invalid_api_key", "API key is invalid."));
    }

    const now = this.clock.now();
    while (this.recent.length > 0 && (this.recent[0] ?? 0) <= now - 1000) this.recent.shift();
    const rateHeaders = (remaining: number): Record<string, string> => ({
      "ratelimit-limit": String(this.requestsPerSecond),
      "ratelimit-remaining": String(Math.max(0, remaining)),
      "ratelimit-reset": "1",
    });
    if (this.recent.length >= this.requestsPerSecond) {
      return respond(
        errorResponse(429, "rate_limit_exceeded", "Too many requests.", {
          ...rateHeaders(0),
          "retry-after": "1",
        }),
      );
    }
    this.recent.push(now);

    const key = headers["idempotency-key"];
    if (key !== undefined && (key.length < 1 || key.length > 256)) {
      return respond(
        errorResponse(400, "invalid_idempotency_key", "The key must be between 1-256 chars."),
      );
    }

    const validation = this.validate(body);
    if (validation !== null)
      return respond(errorResponse(422, validation.name, validation.message));
    const email = body as Record<string, unknown>;

    if (key !== undefined) {
      if (this.inFlight.has(key)) {
        return respond(
          errorResponse(
            409,
            "concurrent_idempotent_requests",
            "Same idempotency key used while original request is still in progress.",
          ),
        );
      }
      const existing = this.keys.get(key);
      const fingerprint = canonical(email);
      if (existing && existing.createdAt > now - idempotencyWindowMs) {
        if (existing.fingerprint !== fingerprint) {
          return respond(
            errorResponse(
              409,
              "invalid_idempotent_request",
              "Same idempotency key used with a different request payload.",
            ),
          );
        }
        return respond(
          this.success(existing.emailId, rateHeaders(this.requestsPerSecond - this.recent.length)),
        );
      }
    }

    this.sequence += 1;
    const id = `00000000-0000-4000-8000-${String(this.sequence).padStart(12, "0")}`;
    const to = typeof email.to === "string" ? [email.to] : (email.to as string[]);
    this.emails.push({
      id,
      idempotencyKey: key ?? null,
      from: email.from as string,
      to,
      subject: email.subject as string,
      html: typeof email.html === "string" ? email.html : undefined,
      text: typeof email.text === "string" ? email.text : undefined,
      headers: (email.headers ?? {}) as Record<string, string>,
      tags: (email.tags ?? []) as Array<{ name: string; value: string }>,
      createdAt: now,
    });
    if (key !== undefined)
      this.keys.set(key, { fingerprint: canonical(email), emailId: id, createdAt: now });
    return respond(this.success(id, rateHeaders(this.requestsPerSecond - this.recent.length)));
  };

  private success(id: string, headers: Record<string, string>): Response {
    return new Response(JSON.stringify({ id }), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  private validate(body: unknown): { name: string; message: string } | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { name: "validation_error", message: "The request body must be a JSON object." };
    }
    const email = body as Record<string, unknown>;
    for (const field of ["from", "to", "subject"]) {
      if (email[field] === undefined) {
        return { name: "missing_required_field", message: `Missing \`${field}\` field.` };
      }
    }
    if (typeof email.from !== "string" || !/@/.test(email.from)) {
      return { name: "invalid_from_address", message: "Invalid `from` field." };
    }
    const to = typeof email.to === "string" ? [email.to] : email.to;
    if (
      !Array.isArray(to) ||
      to.length === 0 ||
      to.length > 50 ||
      !to.every((entry) => typeof entry === "string" && /^[^\s@]+@[^\s@]+$/.test(entry))
    ) {
      return { name: "validation_error", message: "Invalid `to` field." };
    }
    if (typeof email.subject !== "string" || email.subject === "") {
      return { name: "validation_error", message: "Invalid `subject` field." };
    }
    if (typeof email.html !== "string" && typeof email.text !== "string") {
      return { name: "missing_required_field", message: "Missing `html` or `text` field." };
    }
    if (email.tags !== undefined) {
      const tags = email.tags;
      if (
        !Array.isArray(tags) ||
        !tags.every(
          (tag) =>
            typeof tag === "object" &&
            tag !== null &&
            tagPattern.test(String((tag as Record<string, unknown>).name)) &&
            tagPattern.test(String((tag as Record<string, unknown>).value)),
        )
      ) {
        return {
          name: "validation_error",
          message: "Tags may only contain ASCII letters, numbers, underscores and dashes.",
        };
      }
    }
    return null;
  }
}
