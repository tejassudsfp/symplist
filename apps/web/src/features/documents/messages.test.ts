import { describe, expect, it } from "vitest";
import {
  ApiAbortedError,
  ApiConfigurationError,
  ApiError,
  ApiNetworkError,
  ApiProtocolError,
  ServerSideApiCallError,
} from "@/lib/api";
import { describeFailure, isSessionFailure } from "./messages.ts";

function apiError(status: number, code: string, details?: Record<string, unknown>): ApiError {
  return new ApiError({
    status,
    code,
    message: "internal detail",
    requestId: "req-1",
    ...(details ? { details } : {}),
  });
}

describe("describeFailure", () => {
  it("names the conflict without claiming anything was overwritten", () => {
    const failure = describeFailure(apiError(409, "document.conflict"));
    expect(failure.code).toBe("document.conflict");
    expect(failure.title).toBe("The page changed while you were editing");
    expect(failure.description).toContain("Nothing was overwritten");
    expect(failure.retryable).toBe(false);
  });

  it("says the draft is kept for every failure that could look like data loss", () => {
    for (const code of [
      "auth.required",
      "document.too_large",
      "document.read_only",
      "document.edit_invalid",
      "idempotency.mismatch",
    ]) {
      expect(describeFailure(apiError(400, code)).description).toMatch(/draft is kept/i);
    }
  });

  it("offers a retry only where trying again can reasonably work", () => {
    expect(describeFailure(apiError(429, "rate.limited")).retryable).toBe(true);
    expect(describeFailure(apiError(409, "document.stale_cursor")).retryable).toBe(true);
    expect(describeFailure(apiError(403, "auth.forbidden")).retryable).toBe(false);
    expect(describeFailure(apiError(409, "document.history_too_large")).retryable).toBe(false);
  });

  it("treats an unknown 5xx as a retryable problem and keeps its code", () => {
    const failure = describeFailure(apiError(503, "service.unavailable"));
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("service.unavailable");
    expect(failure.title).toBe("Symplist had a problem");
  });

  it("falls back to a generic message for an unknown 4xx, keeping its code", () => {
    const failure = describeFailure(apiError(418, "some.new.code"));
    expect(failure.title).toBe("Something went wrong");
    expect(failure.code).toBe("some.new.code");
  });

  it("describes a network failure as offline with the draft retained", () => {
    const failure = describeFailure(new ApiNetworkError());
    expect(failure.code).toBe("offline");
    expect(failure.description).toMatch(/draft is kept on this device/i);
    expect(failure.retryable).toBe(true);
  });

  it("describes a build with no API origin as unavailable here, not broken", () => {
    for (const error of [new ApiConfigurationError("no origin"), new ServerSideApiCallError()]) {
      const failure = describeFailure(error);
      expect(failure.code).toBe("configuration");
      expect(failure.title).toBe("This page isn't available here");
      expect(failure.retryable).toBe(false);
    }
  });

  it("marks an aborted request so the caller can ignore it", () => {
    expect(describeFailure(new ApiAbortedError()).code).toBe("aborted");
  });

  it("falls back to generic for a protocol error and for a plain throw", () => {
    expect(describeFailure(new ApiProtocolError(502, "bad body")).code).toBe("unknown");
    expect(describeFailure(new Error("boom")).code).toBe("unknown");
    expect(describeFailure("boom").code).toBe("unknown");
  });

  it("never leaks an internal service name, a status code or a stack trace", () => {
    const codes = [
      "auth.required",
      "auth.forbidden",
      "access.locked",
      "not_found",
      "task.archived",
      "document.conflict",
      "document.resync_required",
      "document.stale_cursor",
      "document.cursor_invalid",
      "document.too_large",
      "document.history_too_large",
      "document.integrity_failed",
      "document.edit_invalid",
      "document.read_only",
      "document.draft_stale",
      "idempotency.mismatch",
      "rate.limited",
      "validation.failed",
      "unknown.code",
    ];
    for (const code of codes) {
      const failure = describeFailure(apiError(500, code));
      const text = `${failure.title} ${failure.description}`;
      expect(text).not.toMatch(
        /Nest|Trigger|D1|R2|Cloudflare|stack|internal detail|req-1|\b5\d\d\b/i,
      );
      expect(failure.title.length).toBeGreaterThan(0);
      expect(failure.description.length).toBeGreaterThan(0);
    }
  });
});

describe("isSessionFailure", () => {
  it("is true only for the codes that mean the access or sign-in path", () => {
    expect(isSessionFailure("auth.required")).toBe(true);
    expect(isSessionFailure("auth.forbidden")).toBe(true);
    expect(isSessionFailure("access.locked")).toBe(true);
    expect(isSessionFailure("document.conflict")).toBe(false);
    expect(isSessionFailure("offline")).toBe(false);
  });
});
