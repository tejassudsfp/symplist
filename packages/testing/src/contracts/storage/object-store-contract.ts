import { randomBytes } from "node:crypto";
import { isStorageError, type ObjectStore, type StorageErrorCode } from "@symplist/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface ObjectStoreContractTarget {
  readonly store: ObjectStore;
  /** Body cap the store was configured with; the contract writes one byte more. */
  readonly maxBodyBytes: number;
  readonly close?: () => void | Promise<void>;
}

export interface LiveR2Settings {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Live R2 settings when `LIVE_R2=1` and credentials are present; otherwise the reason to skip. */
export function liveR2Settings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly settings: LiveR2Settings } | { readonly skipReason: string } {
  if (env.LIVE_R2 !== "1") return { skipReason: "set LIVE_R2=1 to run the live R2 contract" };
  const required = [
    "CLOUDFLARE_ACCOUNT_ID",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) return { skipReason: `LIVE_R2=1 but ${missing.join(", ")} missing` };
  return {
    settings: {
      accountId: env.CLOUDFLARE_ACCOUNT_ID as string,
      bucket: env.R2_BUCKET as string,
      accessKeyId: env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    },
  };
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const text = (body: Uint8Array | undefined) => new TextDecoder().decode(body);

async function storageCode(
  promise: Promise<unknown>,
): Promise<StorageErrorCode | "resolved" | "other"> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return isStorageError(error) ? error.code : "other";
  }
}

/**
 * The ObjectStore contract (§1, §17): runs against the local filesystem store always, the R2 store
 * over a local S3 emulator, and live R2 when `LIVE_R2=1`. All keys live under a random prefix that is
 * deleted afterwards, one `delete` per key.
 */
export function describeObjectStoreContract(
  name: string,
  createTarget: () => Promise<ObjectStoreContractTarget>,
): void {
  describe(`ObjectStore contract: ${name}`, () => {
    const root = `contract-tests/${randomBytes(8).toString("hex")}/`;
    let target: ObjectStoreContractTarget;
    let store: ObjectStore;

    beforeAll(async () => {
      target = await createTarget();
      store = target.store;
    });

    afterAll(async () => {
      if (!target) return;
      try {
        let cursor: string | undefined;
        do {
          const page = await store.list({ prefix: root, cursor });
          for (const object of page.objects) await store.delete(object.key);
          cursor = page.cursor;
        } while (cursor);
      } finally {
        await target.close?.();
      }
    });

    it("stores bodies with content type and metadata and reads them back", async () => {
      const key = `${root}roundtrip/object.md.sym`;
      const writeId = "01890000-0000-7000-8000-000000000001";
      const put = await store.put({
        key,
        body: bytes("hello, object"),
        contentType: "application/octet-stream",
        metadata: { "write-id": writeId },
      });
      expect(put.status).toBe("created");
      const stored = await store.get(key);
      expect(text(stored?.body)).toBe("hello, object");
      expect(stored).toMatchObject({
        key,
        size: 13,
        metadata: { "write-id": writeId },
        contentType: "application/octet-stream",
      });
      expect(typeof stored?.etag).toBe("string");
      expect(stored?.etag).not.toMatch(/"/);
      expect(typeof stored?.uploadedAt).toBe("number");
      const head = await store.head(key);
      expect(head).toMatchObject({
        key,
        size: 13,
        etag: stored?.etag,
        metadata: { "write-id": writeId },
      });
      if (put.status === "created" && put.etag !== undefined) expect(put.etag).toBe(stored?.etag);
    });

    it("returns null for missing objects", async () => {
      await expect(store.get(`${root}missing/object`)).resolves.toBeNull();
      await expect(store.head(`${root}missing/object`)).resolves.toBeNull();
    });

    it("creates with If-None-Match: * once, and resolves 412 by the write-id metadata", async () => {
      const key = `${root}conditional/bundle.sym`;
      const first = await store.put({
        key,
        body: bytes("first"),
        ifNoneMatch: "*",
        metadata: { "write-id": "w-1" },
      });
      expect(first.status).toBe("created");
      await expect(
        store.put({
          key,
          body: bytes("second"),
          ifNoneMatch: "*",
          metadata: { "write-id": "w-2" },
        }),
      ).resolves.toEqual({
        status: "exists",
      });
      await expect(store.put({ key, body: bytes("third"), ifNoneMatch: "*" })).resolves.toEqual({
        status: "exists",
      });
      // The same write retried (for example after a lost response) is its own success.
      const retried = await store.put({
        key,
        body: bytes("first"),
        ifNoneMatch: "*",
        metadata: { "write-id": "w-1" },
      });
      expect(retried.status).toBe("created");
      expect(text((await store.get(key))?.body)).toBe("first");
    });

    it("lets exactly one of several concurrent conditional creates win", async () => {
      const key = `${root}race/object`;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          store.put({
            key,
            body: bytes(`writer-${index}`),
            ifNoneMatch: "*",
            metadata: { "write-id": `race-${index}` },
          }),
        ),
      );
      expect(results.filter((result) => result.status === "created")).toHaveLength(1);
      const winner = results.findIndex((result) => result.status === "created");
      const stored = await store.get(key);
      expect(text(stored?.body)).toBe(`writer-${winner}`);
      expect(stored?.metadata["write-id"]).toBe(`race-${winner}`);
    });

    it("overwrites on unconditional puts", async () => {
      const key = `${root}overwrite/object`;
      await store.put({ key, body: bytes("v1"), metadata: { "write-id": "a" } });
      await store.put({ key, body: bytes("version-2"), metadata: { "write-id": "b" } });
      const stored = await store.get(key);
      expect(text(stored?.body)).toBe("version-2");
      expect(stored?.metadata).toEqual({ "write-id": "b" });
      expect(stored?.size).toBe(9);
    });

    it("deletes one key idempotently", async () => {
      const key = `${root}delete/object`;
      await store.put({ key, body: bytes("x") });
      await store.delete(key);
      await expect(store.head(key)).resolves.toBeNull();
      await expect(store.delete(key)).resolves.toBeUndefined();
      await expect(
        store.put({ key, body: bytes("again"), ifNoneMatch: "*" }),
      ).resolves.toMatchObject({ status: "created" });
    });

    it("lists by prefix in key order with pagination and prefix boundaries", async () => {
      const base = `${root}list/`;
      const keys = [`${base}a`, `${base}b/1`, `${base}b/2`, `${base}c`, `${base}d.sym`];
      for (const key of [...keys].reverse())
        await store.put({ key, body: bytes(key), metadata: { "write-id": "w" } });
      await store.put({ key: `${root}list-other/x`, body: bytes("other") });
      await store.put({ key: `${root}li`, body: bytes("short") });

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.list({ prefix: base, limit: 2, cursor });
        expect(page.objects.length).toBeLessThanOrEqual(2);
        for (const object of page.objects) {
          seen.push(object.key);
          expect(object.metadata).toEqual({});
          expect(object.size).toBe(bytes(object.key).byteLength);
        }
        cursor = page.cursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen).toEqual(keys);
      expect(pages).toBe(3);

      const partial = await store.list({ prefix: `${root}li` });
      expect(partial.objects.map((object) => object.key)).toEqual(
        [`${root}li`, `${root}list-other/x`, ...keys].sort(),
      );
      expect(partial.cursor).toBeUndefined();
      await expect(store.list({ prefix: `${root}list/b/` })).resolves.toMatchObject({
        objects: [{ key: `${base}b/1` }, { key: `${base}b/2` }],
      });
      await expect(store.list({ prefix: `${root}nothing-here/` })).resolves.toEqual({
        objects: [],
      });
    });

    it("keeps keys case-sensitive", async () => {
      await store.put({ key: `${root}case/Report`, body: bytes("upper") });
      await store.put({ key: `${root}case/report`, body: bytes("lower") });
      expect(text((await store.get(`${root}case/Report`))?.body)).toBe("upper");
      expect(text((await store.get(`${root}case/report`))?.body)).toBe("lower");
      const listed = await store.list({ prefix: `${root}case/` });
      expect(listed.objects.map((object) => object.key)).toEqual([
        `${root}case/Report`,
        `${root}case/report`,
      ]);
    });

    it("rejects path traversal and malformed keys before touching storage", async () => {
      const invalid = [
        "",
        "/absolute",
        "trailing/",
        "double//slash",
        "../escape",
        `${root}../escape`,
        `${root}./dot`,
        "back\\slash",
        "with space",
        "control\u0001char",
        "caf\u00e9",
        "a".repeat(1025),
      ];
      for (const key of invalid) {
        expect(await storageCode(store.put({ key, body: bytes("x") })), JSON.stringify(key)).toBe(
          "storage.invalid_key",
        );
        expect(await storageCode(store.get(key))).toBe("storage.invalid_key");
        expect(await storageCode(store.head(key))).toBe("storage.invalid_key");
        expect(await storageCode(store.delete(key))).toBe("storage.invalid_key");
      }
      for (const prefix of ["", "/", "../", `${root}../`, "a//"]) {
        expect(await storageCode(store.list({ prefix })), JSON.stringify(prefix)).toBe(
          "storage.invalid_key",
        );
      }
      expect(await storageCode(store.list({ prefix: root, limit: 0 }))).toBe("storage.rejected");
      expect(await storageCode(store.list({ prefix: root, limit: 1001 }))).toBe("storage.rejected");
    });

    it("bounds body and metadata sizes", async () => {
      const key = `${root}bounds/object`;
      const oversized = new Uint8Array(target.maxBodyBytes + 1);
      expect(await storageCode(store.put({ key, body: oversized }))).toBe("storage.too_large");
      await expect(store.head(key)).resolves.toBeNull();
      await expect(
        store.put({ key, body: new Uint8Array(target.maxBodyBytes) }),
      ).resolves.toMatchObject({ status: "created" });
      const invalidMetadata: Array<Record<string, string>> = [
        { "Write-Id": "x" },
        { "write-id": "line\nbreak" },
        { "write-id": "x".repeat(8200) },
      ];
      for (const metadata of invalidMetadata) {
        expect(
          await storageCode(store.put({ key: `${root}bounds/meta`, body: bytes("x"), metadata })),
        ).toBe("storage.invalid_metadata");
      }
    });
  });
}
