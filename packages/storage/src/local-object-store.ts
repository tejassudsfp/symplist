import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { StorageError } from "./errors.ts";
import {
  assertBody,
  assertMetadata,
  assertObjectKey,
  assertPrefix,
  listLimit,
  OBJECT_STORE_LIMITS,
  WRITE_ID_METADATA_KEY,
} from "./keys.ts";
import type {
  ListObjectsInput,
  ListObjectsResult,
  ObjectHead,
  ObjectMetadata,
  ObjectStore,
  PutObjectInput,
  PutObjectResult,
  StoredObject,
} from "./object-store.ts";

export interface LocalObjectStoreOptions {
  /** Directory holding the store; created when missing. */
  readonly root: string;
  /** Environment checked for `NODE_ENV=production`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Cap on bodies written and read; defaults to 100 MiB. */
  readonly maxBodyBytes?: number;
}

/** Default object store directory for `DATA_DRIVER=local` (§16.1). */
export const DEFAULT_LOCAL_OBJECTS_DIR = ".local-data/objects";

/** Metadata sidecar written next to every object body. */
interface Sidecar {
  readonly v: 1;
  readonly size: number;
  readonly etag: string;
  readonly uploadedAt: number;
  readonly contentType: string;
  readonly metadata: ObjectMetadata;
}

const BODY_FILE = "body";
const SIDECAR_FILE = "meta.json";
const OBJECT_SUFFIX = ".o";
const DIRECTORY_SUFFIX = ".d";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Encodes a key segment as a file name that stays distinct on case-insensitive filesystems:
 * upper-case letters become `^` plus the lower-case letter (`^` never appears in a valid key).
 */
function encodeSegment(segment: string): string {
  return segment.replace(/[A-Z]/g, (letter) => `^${letter.toLowerCase()}`);
}

function decodeSegment(name: string): string {
  return name.replace(/\^([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function isSidecar(value: unknown): value is Sidecar {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.size === "number" &&
    typeof record.etag === "string" &&
    typeof record.uploadedAt === "number" &&
    typeof record.contentType === "string" &&
    typeof record.metadata === "object" &&
    record.metadata !== null
  );
}

/**
 * The local development stand-in for R2 (§3.2, decision A7). Each object is a directory holding its
 * body and a `meta.json` sidecar. Every write assembles that directory under `tmp/` with exclusive
 * (`wx`) file creation and commits it with one atomic `rename`, which fails when the key already
 * holds an object, so `If-None-Match: *` creates are atomic and readers never see a body without
 * its metadata. Keys are validated before any path is built and every path is checked to stay under
 * the root. Refuses to start when `NODE_ENV=production`.
 */
export class LocalObjectStore implements ObjectStore {
  readonly root: string;
  private readonly objectsRoot: string;
  private readonly tmpRoot: string;
  private readonly trashRoot: string;
  private readonly maxBodyBytes: number;

  constructor(options: LocalObjectStoreOptions) {
    const env = options.env ?? process.env;
    if (env.NODE_ENV === "production") {
      throw new StorageError(
        "storage.production_refused",
        "The local object store is a development adapter and refuses NODE_ENV=production",
      );
    }
    this.root = resolve(options.root);
    this.objectsRoot = join(this.root, "objects");
    this.tmpRoot = join(this.root, "tmp");
    this.trashRoot = join(this.root, "trash");
    this.maxBodyBytes = options.maxBodyBytes ?? OBJECT_STORE_LIMITS.defaultMaxBodyBytes;
  }

  /** The object directory for a validated key, confined to the objects root. */
  private objectPath(key: string): string {
    const segments = assertObjectKey(key).split("/");
    const last = segments.pop() as string;
    const path = join(
      this.objectsRoot,
      ...segments.map((segment) => `${encodeSegment(segment)}${DIRECTORY_SUFFIX}`),
      `${encodeSegment(last)}${OBJECT_SUFFIX}`,
    );
    if (!resolve(path).startsWith(this.objectsRoot + sep)) {
      throw new StorageError("storage.invalid_key", "Invalid object key");
    }
    return path;
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const target = this.objectPath(input.key);
    const body = assertBody(input.body, this.maxBodyBytes);
    const metadata = assertMetadata(input.metadata);
    const sidecar: Sidecar = {
      v: 1,
      size: body.byteLength,
      etag: createHash("md5").update(body).digest("hex"),
      uploadedAt: Date.now(),
      contentType: input.contentType ?? "application/octet-stream",
      metadata: { ...metadata },
    };

    const staging = join(this.tmpRoot, randomUUID());
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(join(staging, BODY_FILE), body, { flag: "wx" });
      await writeFile(join(staging, SIDECAR_FILE), JSON.stringify(sidecar), { flag: "wx" });

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await mkdir(dirname(target), { recursive: true });
        try {
          await rename(staging, target);
          return { status: "created", etag: sidecar.etag };
        } catch (error) {
          const code = errorCode(error);
          if (code === "ENOENT") continue; // A delete pruned the parent directory; recreate it.
          if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EPERM") throw error;
          if (input.ifNoneMatch === "*") {
            const existing = await this.head(input.key);
            if (!existing) continue; // Deleted in between; try the create again.
            const writeId = metadata[WRITE_ID_METADATA_KEY];
            return writeId !== undefined && existing.metadata[WRITE_ID_METADATA_KEY] === writeId
              ? { status: "created", etag: existing.etag }
              : { status: "exists" };
          }
          // Unconditional put: last writer wins. Move the current object aside, then retry.
          await this.moveToTrash(target);
        }
      }
      throw new StorageError("storage.conflict", "Concurrent writes kept replacing the object");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const target = this.objectPath(key);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sidecar = await this.readSidecar(target);
      if (!sidecar) return null;
      if (sidecar.size > this.maxBodyBytes) {
        throw new StorageError("storage.too_large", "Object body exceeds the size limit");
      }
      let body: Buffer;
      try {
        body = await readFile(join(target, BODY_FILE));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      // A concurrent overwrite can swap the object between the two reads; retry until they agree.
      if (createHash("md5").update(body).digest("hex") !== sidecar.etag) continue;
      return {
        key,
        size: sidecar.size,
        etag: sidecar.etag,
        uploadedAt: sidecar.uploadedAt,
        metadata: sidecar.metadata,
        contentType: sidecar.contentType,
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      };
    }
    throw new StorageError("storage.conflict", "The object changed while it was read");
  }

  async head(key: string): Promise<ObjectHead | null> {
    const sidecar = await this.readSidecar(this.objectPath(key));
    if (!sidecar) return null;
    return {
      key,
      size: sidecar.size,
      etag: sidecar.etag,
      uploadedAt: sidecar.uploadedAt,
      metadata: sidecar.metadata,
      contentType: sidecar.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    const target = this.objectPath(key);
    await this.moveToTrash(target);
    await this.pruneEmptyParents(dirname(target));
  }

  async list(input: ListObjectsInput): Promise<ListObjectsResult> {
    const prefix = assertPrefix(input.prefix);
    const limit = listLimit(input);
    let after: string | undefined;
    if (input.cursor !== undefined) {
      after = Buffer.from(String(input.cursor), "base64url").toString("utf8");
      try {
        assertObjectKey(after);
      } catch {
        throw new StorageError("storage.invalid_cursor", "Invalid list cursor");
      }
    }

    const parts = prefix.split("/");
    const partial = parts.pop() as string;
    const directory = join(
      this.objectsRoot,
      ...parts.map((part) => `${encodeSegment(part)}${DIRECTORY_SUFFIX}`),
    );
    const keyBase = parts.length > 0 ? `${parts.join("/")}/` : "";
    const keys = (await this.collectKeys(directory, keyBase, partial))
      .filter((key) => after === undefined || key > after)
      .sort();

    const objects: ObjectHead[] = [];
    let index = 0;
    for (; index < keys.length && objects.length < limit; index += 1) {
      const key = keys[index] as string;
      const head = await this.head(key);
      if (head)
        objects.push({
          key,
          size: head.size,
          etag: head.etag,
          uploadedAt: head.uploadedAt,
          metadata: {},
        });
    }
    const last = objects[objects.length - 1];
    return index < keys.length && last
      ? { objects, cursor: Buffer.from(last.key, "utf8").toString("base64url") }
      : { objects };
  }

  /** Keys under `directory` whose next segment starts with `partial` (every key when empty). */
  private async collectKeys(
    directory: string,
    keyBase: string,
    partial: string,
  ): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
      throw error;
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const isObject = entry.name.endsWith(OBJECT_SUFFIX);
      const isDirectory = entry.name.endsWith(DIRECTORY_SUFFIX);
      if (!isObject && !isDirectory) continue;
      const segment = decodeSegment(entry.name.slice(0, -2));
      if (!segment.startsWith(partial)) continue;
      if (isObject) keys.push(`${keyBase}${segment}`);
      else
        keys.push(
          ...(await this.collectKeys(join(directory, entry.name), `${keyBase}${segment}/`, "")),
        );
    }
    return keys;
  }

  private async readSidecar(target: string): Promise<Sidecar | null> {
    let text: string;
    try {
      text = await readFile(join(target, SIDECAR_FILE), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isSidecar(parsed)) {
      throw new StorageError("storage.unavailable", "Corrupt object metadata sidecar");
    }
    return parsed;
  }

  private async moveToTrash(target: string): Promise<void> {
    const trash = join(this.trashRoot, randomUUID());
    await mkdir(this.trashRoot, { recursive: true });
    try {
      await rename(target, trash);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await rm(trash, { recursive: true, force: true });
  }

  private async pruneEmptyParents(directory: string): Promise<void> {
    let current = directory;
    while (current.startsWith(this.objectsRoot + sep)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  }

  /**
   * Removes staging and trash leftovers from interrupted writes. Call only while no write is in
   * progress, for example at startup.
   */
  async sweep(): Promise<void> {
    await rm(this.tmpRoot, { recursive: true, force: true });
    await rm(this.trashRoot, { recursive: true, force: true });
  }
}

export function createLocalObjectStore(options: LocalObjectStoreOptions): LocalObjectStore {
  return new LocalObjectStore(options);
}
