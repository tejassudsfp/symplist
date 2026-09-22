import { describe, expect, it } from "vitest";
import { upstreamFailureStatus } from "./errors.ts";

describe("upstreamFailureStatus", () => {
  it("reads the status a provider nests in a successful response body", () => {
    // The exact shape Composio returned for a dead Gmail credential.
    expect(
      upstreamFailureStatus("HTTP 401: Request had invalid authentication credentials.", {
        successful: false,
        error: "HTTP 401: Request had invalid authentication credentials.",
        data: { message: "HTTP 401: ...", status_code: 401 },
        mercury_last_http_status_code: 401,
        auth_refresh_required: false,
      }),
    ).toBe(401);
  });

  it("falls back through each documented field and then the message prefix", () => {
    expect(upstreamFailureStatus(null, { mercury_last_http_status_code: 403 })).toBe(403);
    expect(upstreamFailureStatus(null, { data: { status_code: 429 } })).toBe(429);
    expect(upstreamFailureStatus(null, { data: { statusCode: 500 } })).toBe(500);
    expect(upstreamFailureStatus("HTTP 503: upstream down", {})).toBe(503);
    expect(upstreamFailureStatus(null, { error: "HTTP 404: nope" })).toBe(404);
  });

  it("reports nothing when no status is stated, so the caller keeps its safe default", () => {
    expect(upstreamFailureStatus("something went wrong", {})).toBeUndefined();
    expect(upstreamFailureStatus(null, null)).toBeUndefined();
    // Out-of-range or non-numeric values must not be mistaken for a status.
    expect(upstreamFailureStatus(null, { mercury_last_http_status_code: 200 })).toBeUndefined();
    expect(upstreamFailureStatus(null, { mercury_last_http_status_code: "oops" })).toBeUndefined();
  });
});
