import { describe, expect, it } from "vitest";
import { ApiAbortedError, ApiNetworkError, ApiProtocolError } from "@/lib/api";
import { describeWait, detailNumber, genericProblemMessage, hasCode, problemOf } from "./errors.ts";
import { accessApiError } from "./test-support.tsx";

describe("reading a failed access request (§6)", () => {
  it("classifies the transport failures", () => {
    expect(problemOf(new ApiNetworkError())).toEqual({ kind: "network" });
    expect(problemOf(new ApiAbortedError())).toEqual({ kind: "aborted" });
    expect(problemOf(new ApiProtocolError(200, "bad body"))).toEqual({ kind: "unexpected" });
    expect(problemOf(new Error("boom"))).toEqual({ kind: "unexpected" });
  });

  it("treats an ended session as its own case", () => {
    expect(problemOf(accessApiError("auth.session_required", 401))).toEqual({
      kind: "session_expired",
    });
  });

  it("carries the wait of every throttling code", () => {
    for (const code of ["rate.limited", "otp.cooldown", "otp.send_limited"]) {
      expect(problemOf(accessApiError(code, 429, { retryAfterSeconds: 30 }))).toEqual({
        kind: "throttled",
        code,
        retryAfterSeconds: 30,
      });
    }
  });

  it("keeps a code a screen can explain, even at 502", () => {
    expect(problemOf(accessApiError("auth.delivery_failed", 502))).toMatchObject({
      kind: "api",
      code: "auth.delivery_failed",
      status: 502,
    });
    expect(problemOf(accessApiError("internal", 500))).toEqual({ kind: "unexpected" });
  });

  it("reads details and codes", () => {
    const error = accessApiError("otp.incorrect", 400, { details: { attemptsRemaining: 2 } });
    expect(detailNumber(error, "attemptsRemaining")).toBe(2);
    expect(detailNumber(error, "missing")).toBeNull();
    expect(hasCode(error, "otp.incorrect")).toBe(true);
    expect(hasCode(new Error("x"), "otp.incorrect")).toBe(false);
  });

  it("says how long to wait in calm words", () => {
    expect(describeWait(1)).toBe("a moment");
    expect(describeWait(45)).toBe("45 seconds");
    expect(describeWait(60)).toBe("a minute");
    expect(describeWait(150)).toBe("3 minutes");
    expect(describeWait(3600)).toBe("about an hour");
    expect(describeWait(7200)).toBe("about 2 hours");
  });

  it("has plain generic copy for anything a screen does not explain", () => {
    expect(genericProblemMessage({ kind: "network" })).toMatch(/Check your connection/);
    expect(
      genericProblemMessage({ kind: "throttled", code: "rate.limited", retryAfterSeconds: 60 }),
    ).toMatch(/Try again in a minute/);
    expect(genericProblemMessage({ kind: "unexpected" })).toMatch(/Something went wrong/);
  });
});
