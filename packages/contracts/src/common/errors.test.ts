import { describe, expect, it } from "vitest";
import {
  errorCodeSchema,
  errorEnvelopeSchema,
  errorEnvelopeSchemaFor,
  errorEnvelopeWithDetailsSchemaFor,
  rateLimitedErrorSchema,
  validationErrorSchema,
} from "./envelope.ts";
import { commonErrorCodes, defineErrorCodes, type ErrorHttpStatus } from "./errors.ts";

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("foundation error codes (§5, §6, §6.1, §2.1)", () => {
  it("maps every foundation code to its HTTP status", () => {
    expect(commonErrorCodes).toEqual({
      not_found: 404,
      validation: 400,
      internal: 500,
      "auth.session_required": 401,
      "auth.origin_forbidden": 403,
      "auth.csrf_invalid": 403,
      "access.unverified": 403,
      "access.locked": 403,
      "access.relocked": 403,
      "access.suspended": 403,
      "access.admin_required": 403,
      "idempotency.key_required": 400,
      "idempotency.key_invalid": 400,
      "idempotency.mismatch": 422,
      "idempotency.in_progress": 409,
      "rate.limited": 503,
      "task.archived": 409,
      "task.run_active": 409,
    });
    expect(Object.isFrozen(commonErrorCodes)).toBe(true);
  });

  it("rejects malformed codes and non-error statuses when a feature declares its map", () => {
    expect(() => defineErrorCodes({ "Task.Archived": 409 })).toThrow(/Invalid error code/);
    expect(() => defineErrorCodes({ "task archived": 409 })).toThrow(/Invalid error code/);
    expect(() => defineErrorCodes({ "task.": 409 })).toThrow(/Invalid error code/);
    expect(() => defineErrorCodes({ "task.ok": 200 as ErrorHttpStatus })).toThrow(/HTTP status/);
    expect(defineErrorCodes({ "document.conflict": 409 })).toEqual({ "document.conflict": 409 });
  });
});

describe("error envelope (§6)", () => {
  const envelope = {
    error: {
      code: "task.archived",
      message: "This task is archived.",
      requestId: "0199a5a0-7c1e-7b3a-9f2e-3c4d5e6f7a8b",
    },
  };

  it("round-trips a valid envelope with and without details", () => {
    expect(errorEnvelopeSchema.parse(roundTrip(envelope))).toEqual(envelope);
    const withDetails = { error: { ...envelope.error, details: { current: 3 } } };
    expect(errorEnvelopeSchema.parse(roundTrip(withDetails))).toEqual(withDetails);
  });

  it("rejects unknown keys at the top level and inside error", () => {
    expect(errorEnvelopeSchema.safeParse({ ...envelope, stack: "at x" }).success).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ error: { ...envelope.error, stack: "at x" } }).success,
    ).toBe(false);
  });

  it.each([
    ["a missing request id", { code: "not_found", message: "Not found" }],
    ["an empty message", { code: "not_found", message: "", requestId: "r1" }],
    ["an over-long message", { code: "not_found", message: "x".repeat(501), requestId: "r1" }],
    ["an uppercase code", { code: "NOT_FOUND", message: "Not found", requestId: "r1" }],
    ["a request id with spaces", { code: "not_found", message: "Not found", requestId: "r 1" }],
    ["array details", { code: "not_found", message: "Not found", requestId: "r1", details: [] }],
  ])("rejects %s", (_label, error) => {
    expect(errorEnvelopeSchema.safeParse({ error }).success).toBe(false);
  });

  it("validates error codes as stable dotted identifiers", () => {
    expect(errorCodeSchema.safeParse("share_grant.not_found").success).toBe(true);
    expect(errorCodeSchema.safeParse(`a.${"b".repeat(100)}`).success).toBe(false);
  });

  it("builds strict per-code envelopes", () => {
    const archived = errorEnvelopeSchemaFor("task.archived");
    expect(archived.parse(roundTrip(envelope))).toEqual(envelope);
    expect(
      archived.safeParse({ error: { ...envelope.error, code: "task.run_active" } }).success,
    ).toBe(false);
    expect(archived.safeParse({ error: { ...envelope.error, details: {} } }).success).toBe(false);
    expect(() => errorEnvelopeSchemaFor("Bad Code")).toThrow(/Invalid error code/);
    expect(() => errorEnvelopeWithDetailsSchemaFor("Bad Code", rateLimitedErrorSchema)).toThrow(
      /Invalid error code/,
    );
  });

  it("requires retryAfter in whole seconds on rate.limited", () => {
    const limited = {
      error: {
        code: "rate.limited",
        message: "Try again soon.",
        requestId: "r1",
        details: { retryAfter: 30 },
      },
    };
    expect(rateLimitedErrorSchema.parse(roundTrip(limited))).toEqual(limited);
    for (const details of [
      undefined,
      {},
      { retryAfter: 0 },
      { retryAfter: 1.5 },
      { retryAfter: 86_401 },
      { retryAfter: "30" },
      { retryAfter: 30, extra: true },
    ]) {
      expect(
        rateLimitedErrorSchema.safeParse({ error: { ...limited.error, details } }).success,
      ).toBe(false);
    }
  });

  it("carries validation issues without submitted values", () => {
    const invalid = {
      error: {
        code: "validation",
        message: "The request is invalid.",
        requestId: "r1",
        details: { issues: [{ path: ["title", 0], code: "too_small", message: "Too short" }] },
      },
    };
    expect(validationErrorSchema.parse(roundTrip(invalid))).toEqual(invalid);
    const withInput = {
      error: {
        ...invalid.error,
        details: {
          issues: [
            { path: ["passphrase"], code: "too_small", message: "Too short", input: "hunter2" },
          ],
        },
      },
    };
    expect(validationErrorSchema.safeParse(withInput).success).toBe(false);
    const empty = { error: { ...invalid.error, details: { issues: [] } } };
    expect(validationErrorSchema.safeParse(empty).success).toBe(false);
  });
});
