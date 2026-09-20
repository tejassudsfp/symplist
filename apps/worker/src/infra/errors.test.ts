import { ConfigError } from "@symplist/config";
import { DecryptionFailedError } from "@symplist/crypto";
import { DbRateLimitedError, DbStatementError } from "@symplist/db";
import { StorageError } from "@symplist/storage";
import { findMarkerIn } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { toWorkerError, WorkerError, withMappedErrors } from "./errors.ts";

const MARKER = "MARKER-e41c-provider-detail";

function withDetail<T extends object>(error: T, extra: Record<string, unknown> = {}): T {
  return Object.assign(error, { responseBody: `{"prompt":"${MARKER}"}`, ...extra });
}

describe("worker error mapping (§8.3)", () => {
  it.each([
    [
      "a D1 statement failure",
      new DbStatementError({ providerMessage: `UNIQUE constraint failed: ${MARKER}` }),
      "db.statement_failed",
      false,
    ],
    ["a D1 rate limit", new DbRateLimitedError("http_429", 1_000), "rate.limited", true],
    [
      "an R2 failure",
      new StorageError("storage.unavailable", `GET u/${MARKER}`),
      "storage.unavailable",
      true,
    ],
    [
      "a crypto failure",
      new DecryptionFailedError("field envelope"),
      "crypto.decryption_failed",
      false,
    ],
    [
      "a configuration error",
      new ConfigError("worker", [{ variable: "API_ORIGIN", message: MARKER }]),
      "config.invalid",
      false,
    ],
    [
      "an AI SDK call failure",
      withDetail(Object.assign(new Error(`429 for ${MARKER}`), { name: "AI_APICallError" })),
      "ai.unavailable",
      true,
    ],
    [
      "a Composio rate limit",
      withDetail(
        Object.assign(new Error(MARKER), {
          name: "ComposioError",
          status: 429,
          requestId: "req_1",
        }),
      ),
      "integration.rate_limited",
      true,
    ],
    [
      "a Composio client rejection",
      withDetail(
        Object.assign(new Error(MARKER), { name: "APIError", status: 400, requestId: "req_2" }),
      ),
      "integration.rejected",
      false,
    ],
    [
      "a Trigger API error",
      Object.assign(new Error(MARKER), { name: "ApiError", status: 503 }),
      "trigger.unavailable",
      true,
    ],
    [
      "a Git failure",
      Object.assign(new Error(`fatal: ${MARKER}`), { code: 128, cmd: `git show ${MARKER}` }),
      "git.failed",
      false,
    ],
    [
      "a network failure",
      Object.assign(new TypeError("fetch failed"), { cause: new Error(MARKER) }),
      "network.unavailable",
      true,
    ],
    ["an abort", Object.assign(new Error(MARKER), { name: "AbortError" }), "run.aborted", false],
    [
      "a file system error",
      Object.assign(new Error(`ENOENT ${MARKER}`), { code: "ENOENT", path: MARKER }),
      "system.io_failed",
      false,
    ],
    ["a plain error", new Error(MARKER), "internal.error", false],
    ["a thrown string", MARKER, "internal.error", false],
  ] as const)("maps %s to a stable code with no detail", (_what, error, code, retryable) => {
    const mapped = toWorkerError(error);
    expect(mapped).toBeInstanceOf(WorkerError);
    expect(mapped.code).toBe(code);
    expect(mapped.retryable).toBe(retryable);
    expect(mapped.message).toBe(code);
    expect(findMarkerIn(mapped, MARKER)).toEqual([]);
    expect(JSON.stringify(mapped)).not.toContain(MARKER);
    expect((mapped as { cause?: unknown }).cause).toBeUndefined();
  });

  it("never lets an arbitrary code string through", () => {
    expect(new WorkerError(`bad code ${MARKER}`).message).toBe("internal.error");
    expect(toWorkerError(Object.assign(new Error("x"), { code: `a.${"b".repeat(80)}` })).code).toBe(
      "internal.error",
    );
  });

  it("rethrows failures of an operation as mapped errors", async () => {
    await expect(
      withMappedErrors(async () => Promise.reject(new StorageError("storage.conflict", MARKER))),
    ).rejects.toMatchObject({
      name: "WorkerError",
      message: "storage.conflict",
    });
    await expect(withMappedErrors(async () => 5)).resolves.toBe(5);
  });
});
