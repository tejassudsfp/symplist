import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeObjectStoreContract } from "../../testing/src/contracts/storage/object-store-contract.ts";
import { S3Emulator } from "../../testing/src/contracts/storage/s3-emulator.ts";
import { StorageError } from "./errors.ts";
import { R2ObjectStore, r2ClientConfig } from "./r2-object-store.ts";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "symplist-test";
// Throwaway credentials that only the local emulator ever sees.
const ACCESS_KEY_ID = "emulator-access-key";
const SECRET_ACCESS_KEY = "emulator-secret-key-not-real";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("r2ClientConfig (§1 R2 rules)", () => {
  it("uses region auto, the account endpoint and checksums only when required", () => {
    expect(
      r2ClientConfig({
        accountId: ACCOUNT_ID,
        bucket: BUCKET,
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      }),
    ).toMatchObject({
      region: "auto",
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { connectionTimeout: 10_000, socketTimeout: 60_000 },
    });
    expect(
      r2ClientConfig({
        accountId: ACCOUNT_ID,
        bucket: BUCKET,
        accessKeyId: "a",
        secretAccessKey: "b",
        jurisdiction: "eu",
      }).endpoint,
    ).toBe(`https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
  });

  it("resolves those settings on the constructed S3 client", async () => {
    const store = new R2ObjectStore({
      accountId: ACCOUNT_ID,
      bucket: BUCKET,
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    await expect(store.client.config.region()).resolves.toBe("auto");
    await expect(store.client.config.requestChecksumCalculation()).resolves.toBe("WHEN_REQUIRED");
    await expect(store.client.config.responseChecksumValidation()).resolves.toBe("WHEN_REQUIRED");
  });

  it("validates configuration", () => {
    const base = { accountId: ACCOUNT_ID, bucket: BUCKET, accessKeyId: "a", secretAccessKey: "b" };
    expect(() => r2ClientConfig({ ...base, accountId: "evil.example.com/" })).toThrow(StorageError);
    expect(() => r2ClientConfig({ ...base, bucket: "Bad_Bucket" })).toThrow(/R2_BUCKET/);
    expect(() => r2ClientConfig({ ...base, secretAccessKey: "" })).toThrow(/credentials/);
  });
});

describe("R2ObjectStore requests", () => {
  const emulator = new S3Emulator();
  let store: R2ObjectStore;

  beforeAll(async () => {
    await emulator.start();
    store = new R2ObjectStore({
      accountId: ACCOUNT_ID,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      endpoint: emulator.endpoint,
      forcePathStyle: true,
      maxBodyBytes: 1024,
      maxAttempts: 1,
    });
  });
  afterAll(() => emulator.stop());
  beforeEach(() => {
    emulator.requests.length = 0;
  });

  it("sends If-None-Match: * and write-id metadata without SDK checksum headers", async () => {
    await store.put({
      key: "u/owner/bundles/t/1-w.bundle.sym",
      body: bytes("bundle"),
      ifNoneMatch: "*",
      metadata: { "write-id": "w" },
    });
    const [put] = emulator.requests;
    expect(put?.method).toBe("PUT");
    expect(put?.headers["if-none-match"]).toBe("*");
    expect(put?.headers["x-amz-meta-write-id"]).toBe("w");
    const checksumHeaders = Object.keys(put?.headers ?? {}).filter(
      (name) =>
        name.startsWith("x-amz-checksum") ||
        name === "x-amz-sdk-checksum-algorithm" ||
        name === "x-amz-trailer",
    );
    expect(checksumHeaders).toEqual([]);
    expect(put?.headers["content-encoding"]).toBeUndefined();

    await store.get("u/owner/bundles/t/1-w.bundle.sym");
    expect(emulator.requests[1]?.headers["x-amz-checksum-mode"]).toBeUndefined();
  });

  it("treats 412 as exists and checks the stored write-id with HeadObject", async () => {
    const key = "u/owner/search/2-w.idx";
    await store.put({
      key,
      body: bytes("index"),
      ifNoneMatch: "*",
      metadata: { "write-id": "w-original" },
    });
    emulator.requests.length = 0;

    await expect(
      store.put({
        key,
        body: bytes("other"),
        ifNoneMatch: "*",
        metadata: { "write-id": "w-other" },
      }),
    ).resolves.toEqual({
      status: "exists",
    });
    expect(emulator.requests.map((request) => request.method)).toEqual(["PUT", "HEAD"]);

    emulator.requests.length = 0;
    await expect(
      store.put({
        key,
        body: bytes("index"),
        ifNoneMatch: "*",
        metadata: { "write-id": "w-original" },
      }),
    ).resolves.toMatchObject({
      status: "created",
    });
    expect(emulator.requests.map((request) => request.method)).toEqual(["PUT", "HEAD"]);
  });

  it("resolves a 409 conditional conflict by the stored object, or reports storage.conflict", async () => {
    emulator.failNext({ status: 409, code: "ConditionalRequestConflict", method: "PUT" });
    await expect(
      store.put({
        key: "u/owner/race/none",
        body: bytes("x"),
        ifNoneMatch: "*",
        metadata: { "write-id": "w" },
      }),
    ).rejects.toMatchObject({
      code: "storage.conflict",
    });
    await store.put({
      key: "u/owner/race/some",
      body: bytes("x"),
      metadata: { "write-id": "winner" },
    });
    emulator.failNext({ status: 409, code: "ConditionalRequestConflict", method: "PUT" });
    await expect(
      store.put({
        key: "u/owner/race/some",
        body: bytes("y"),
        ifNoneMatch: "*",
        metadata: { "write-id": "loser" },
      }),
    ).resolves.toEqual({
      status: "exists",
    });
  });

  it("deletes with one DeleteObject per key and never a batch delete", async () => {
    await store.put({ key: "u/owner/jobs/r/1.in.sym", body: bytes("in") });
    await store.put({ key: "u/owner/jobs/r/1.out.sym", body: bytes("out") });
    emulator.requests.length = 0;
    const page = await store.list({ prefix: "u/owner/jobs/" });
    for (const object of page.objects) await store.delete(object.key);
    expect(emulator.requests.map((request) => `${request.method} ${request.key}`)).toEqual([
      "GET ",
      "DELETE u/owner/jobs/r/1.in.sym",
      "DELETE u/owner/jobs/r/1.out.sym",
    ]);
    expect(
      emulator.requests.some((request) => request.method === "POST" || request.query.has("delete")),
    ).toBe(false);
  });

  it("pages ListObjectsV2 with max-keys and continuation tokens", async () => {
    for (const name of ["a", "b", "c"])
      await store.put({ key: `u/pager/${name}`, body: bytes(name) });
    emulator.requests.length = 0;
    const first = await store.list({ prefix: "u/pager/", limit: 2 });
    expect(first.objects.map((object) => object.key)).toEqual(["u/pager/a", "u/pager/b"]);
    expect(first.cursor).toBeDefined();
    const second = await store.list({ prefix: "u/pager/", limit: 2, cursor: first.cursor });
    expect(second).toMatchObject({ objects: [{ key: "u/pager/c", size: 1 }] });
    expect(second.cursor).toBeUndefined();
    expect(emulator.requests[0]?.query.get("max-keys")).toBe("2");
    expect(emulator.requests[0]?.query.get("prefix")).toBe("u/pager/");
    expect(emulator.requests[1]?.query.get("continuation-token")).toBe(first.cursor);
    await expect(store.list({ prefix: "u/pager/", cursor: "" })).rejects.toMatchObject({
      code: "storage.invalid_cursor",
    });
  });

  it("refuses to download bodies beyond the limit", async () => {
    emulator.seed(BUCKET, "u/owner/big", new Uint8Array(4096));
    await expect(store.get("u/owner/big")).rejects.toMatchObject({ code: "storage.too_large" });
  });

  it("maps provider failures to stable codes without keys or credentials", async () => {
    const cases = [
      { status: 403, code: "AccessDenied", expected: "storage.unauthorized" },
      { status: 429, code: "SlowDown", expected: "storage.rate_limited" },
      { status: 503, code: "ServiceUnavailable", expected: "storage.unavailable" },
      { status: 400, code: "InvalidArgument", expected: "storage.rejected" },
    ];
    for (const { status, code, expected } of cases) {
      emulator.failNext({ status, code, method: "GET" });
      const error = (await store
        .get("u/owner/secret-key-name")
        .catch((caught: unknown) => caught)) as StorageError;
      expect(error).toBeInstanceOf(StorageError);
      expect(error.code).toBe(expected);
      expect(error.httpStatus).toBe(status);
      const serialized = JSON.stringify([error.message, error.stack, { ...error }]);
      expect(serialized).not.toContain("secret-key-name");
      expect(serialized).not.toContain(SECRET_ACCESS_KEY);
      expect(serialized).not.toContain(ACCESS_KEY_ID);
    }
  });

  it("applies connection and socket timeouts to the SDK's HTTP handler", async () => {
    await store.head("u/owner/timeouts");
    const handler = store.client.config.requestHandler as unknown as {
      httpHandlerConfigs(): Record<string, unknown>;
    };
    expect(handler.httpHandlerConfigs()).toMatchObject({
      connectionTimeout: 10_000,
      socketTimeout: 60_000,
    });
  });

  it("reports an unreachable endpoint as unavailable", async () => {
    const offline = new R2ObjectStore({
      accountId: ACCOUNT_ID,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      endpoint: "http://127.0.0.1:1",
      forcePathStyle: true,
      maxAttempts: 1,
    });
    await expect(offline.head("u/owner/x")).rejects.toMatchObject({ code: "storage.unavailable" });
  });
});

describe("R2ObjectStore contract over the S3 emulator", () => {
  const emulator = new S3Emulator();
  beforeAll(() => emulator.start());
  afterAll(() => emulator.stop());

  describeObjectStoreContract("R2 store over a local S3 emulator", async () => {
    const maxBodyBytes = 64 * 1024;
    return {
      store: new R2ObjectStore({
        accountId: ACCOUNT_ID,
        bucket: BUCKET,
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        endpoint: emulator.endpoint,
        forcePathStyle: true,
        maxBodyBytes,
      }),
      maxBodyBytes,
    };
  });
});
