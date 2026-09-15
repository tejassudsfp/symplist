import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeObjectStoreContract } from "../../testing/src/contracts/storage/object-store-contract.ts";
import { StorageError } from "./errors.ts";
import { createLocalObjectStore } from "./local-object-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "symplist-objects-"));
  dirs.push(dir);
  return dir;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("LocalObjectStore", () => {
  it("refuses NODE_ENV=production", () => {
    expect(() =>
      createLocalObjectStore({ root: tempRoot(), env: { NODE_ENV: "production" } }),
    ).toThrow(StorageError);
    expect(() =>
      createLocalObjectStore({ root: tempRoot(), env: { NODE_ENV: "production" } }),
    ).toThrow(expect.objectContaining({ code: "storage.production_refused" }));
  });

  it("writes each object as a body plus a metadata sidecar inside the root", async () => {
    const root = tempRoot();
    const store = createLocalObjectStore({ root, env: {} });
    await store.put({
      key: "u/Owner-1/docs/task/commit.md.sym",
      body: bytes("body"),
      metadata: { "write-id": "w-1" },
    });
    const objectDir = join(
      root,
      "objects",
      "u.d",
      "^owner-1.d",
      "docs.d",
      "task.d",
      "commit.md.sym.o",
    );
    expect(readFileSync(join(objectDir, "body"), "utf8")).toBe("body");
    const sidecar = JSON.parse(readFileSync(join(objectDir, "meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(sidecar).toMatchObject({
      v: 1,
      size: 4,
      metadata: { "write-id": "w-1" },
      contentType: "application/octet-stream",
    });
    expect(sidecar.etag).toBe(createHash("md5").update("body").digest("hex"));
    // Staging directories are cleaned up after the commit.
    expect(existsSync(join(root, "tmp")) ? readdirSync(join(root, "tmp")) : []).toEqual([]);
  });

  it("keeps an object and a longer key under it apart", async () => {
    const store = createLocalObjectStore({ root: tempRoot(), env: {} });
    await store.put({ key: "u/a", body: bytes("object") });
    await store.put({ key: "u/a/b", body: bytes("nested") });
    expect(new TextDecoder().decode((await store.get("u/a"))?.body)).toBe("object");
    expect(new TextDecoder().decode((await store.get("u/a/b"))?.body)).toBe("nested");
    await expect(store.list({ prefix: "u/" })).resolves.toMatchObject({
      objects: [{ key: "u/a" }, { key: "u/a/b" }],
    });
  });

  it("never escapes the root, even for dot-heavy segments", async () => {
    const root = tempRoot();
    const store = createLocalObjectStore({ root: join(root, "store"), env: {} });
    await store.put({ key: "..a/...b/c..", body: bytes("dots") });
    expect(existsSync(join(root, "store", "objects", "..a.d", "...b.d", "c...o", "body"))).toBe(
      true,
    );
    await expect(store.put({ key: "../outside", body: bytes("x") })).rejects.toMatchObject({
      code: "storage.invalid_key",
    });
    await expect(store.get("u/../../etc/passwd")).rejects.toMatchObject({
      code: "storage.invalid_key",
    });
    expect(existsSync(join(root, "outside.o"))).toBe(false);
  });

  it("ignores interrupted writes in staging and prunes empty directories on delete", async () => {
    const root = tempRoot();
    const store = createLocalObjectStore({ root, env: {} });
    mkdirSync(join(root, "tmp", "interrupted"), { recursive: true });
    writeFileSync(join(root, "tmp", "interrupted", "body"), "partial");
    await store.put({ key: "u/owner/x", body: bytes("x") });
    await expect(store.list({ prefix: "u/" })).resolves.toMatchObject({
      objects: [{ key: "u/owner/x" }],
    });
    await store.delete("u/owner/x");
    expect(existsSync(join(root, "objects", "u.d"))).toBe(false);
    await store.sweep();
    expect(existsSync(join(root, "tmp"))).toBe(false);
  });

  it("rejects a corrupt sidecar and an invalid cursor", async () => {
    const root = tempRoot();
    const store = createLocalObjectStore({ root, env: {} });
    await store.put({ key: "u/owner/x", body: bytes("x") });
    writeFileSync(
      join(root, "objects", "u.d", "owner.d", "x.o", "meta.json"),
      JSON.stringify({ v: 2 }),
    );
    await expect(store.head("u/owner/x")).rejects.toMatchObject({ code: "storage.unavailable" });
    await expect(store.list({ prefix: "u/", cursor: "!!!" })).rejects.toMatchObject({
      code: "storage.invalid_cursor",
    });
  });

  it("refuses to read bodies beyond its limit", async () => {
    const root = tempRoot();
    await createLocalObjectStore({ root, env: {} }).put({
      key: "u/big",
      body: new Uint8Array(2048),
    });
    const small = createLocalObjectStore({ root, env: {}, maxBodyBytes: 1024 });
    await expect(small.get("u/big")).rejects.toMatchObject({ code: "storage.too_large" });
  });
});

describeObjectStoreContract("local filesystem store", async () => {
  const root = mkdtempSync(join(tmpdir(), "symplist-objects-contract-"));
  const maxBodyBytes = 64 * 1024;
  return {
    store: createLocalObjectStore({ root, env: {}, maxBodyBytes }),
    maxBodyBytes,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
});
