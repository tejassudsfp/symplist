import type { AccountDataKey, ObjectEnvelopeContext, RandomOptions } from "@symplist/crypto";
import { decryptObject, encryptObject, zeroize } from "@symplist/crypto";
import { type ObjectStore, WRITE_ID_METADATA_KEY } from "@symplist/storage";
import {
  type BundleRef,
  bundleEnvelopeContext,
  bundleObjectKey,
  type JobRef,
  jobEnvelopeContext,
  jobObjectKey,
  type SnapshotRef,
  snapshotEnvelopeContext,
  snapshotObjectKey,
} from "./keys.ts";
import {
  ArtifactIntegrityError,
  type DocumentSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  markdownDigest,
} from "./snapshot.ts";

/**
 * A bounded LRU of encrypted artifact bytes by object key. Bundle and snapshot keys are immutable
 * (a key never names different bytes), so cached ciphertext never goes stale, and caching only
 * ciphertext means nothing decrypts without the account key read in the caller's authorized batch.
 */
export class CiphertextCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(private readonly maxBytes: number = 64 * 1024 * 1024) {}

  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Uint8Array): void {
    if (value.byteLength > this.maxBytes / 4) return;
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.byteLength;
    for (const [oldest, oldValue] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= oldValue.byteLength;
    }
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.bytes -= existing.byteLength;
    this.entries.delete(key);
  }

  get size(): number {
    return this.bytes;
  }
}

export interface DocumentArtifactsOptions {
  readonly objects: ObjectStore;
  readonly cache?: CiphertextCache;
  readonly random?: RandomOptions;
}

/**
 * Encrypted document artifacts in R2 (§4.1, §9.2): full Git bundles, immutable head snapshots and
 * `document-git` job objects, each a SYMO object envelope under the owner's account data key.
 * Uploads use `If-None-Match: *` with the attempt's write id in metadata; reads authenticate the
 * owner, task and artifact identity through the envelope AAD and fail without plaintext output.
 */
export class DocumentArtifacts {
  private readonly objects: ObjectStore;
  private readonly cache: CiphertextCache;
  private readonly random: RandomOptions | undefined;

  constructor(options: DocumentArtifactsOptions) {
    this.objects = options.objects;
    this.cache = options.cache ?? new CiphertextCache();
    this.random = options.random;
  }

  private async read(objectKey: string, cacheable: boolean): Promise<Uint8Array> {
    const cached = cacheable ? this.cache.get(objectKey) : undefined;
    if (cached) return cached;
    const stored = await this.objects.get(objectKey);
    if (!stored) throw new ArtifactIntegrityError("missing");
    if (cacheable) this.cache.set(objectKey, stored.body);
    return stored.body;
  }

  private open(key: AccountDataKey, context: ObjectEnvelopeContext, envelope: Uint8Array): Buffer {
    try {
      return Buffer.from(decryptObject(key, context, envelope));
    } catch {
      throw new ArtifactIntegrityError("decrypt_failed");
    }
  }

  private async write(
    objectKey: string,
    envelope: Uint8Array,
    writeId: string,
  ): Promise<"created" | "exists"> {
    const result = await this.objects.put({
      key: objectKey,
      body: envelope,
      contentType: "application/octet-stream",
      ifNoneMatch: "*",
      metadata: { [WRITE_ID_METADATA_KEY]: writeId },
    });
    return result.status;
  }

  /** Encrypts and uploads a bundle to its immutable key. A key that already exists is an integrity failure. */
  async putBundle(key: AccountDataKey, ref: BundleRef, bundle: Uint8Array): Promise<string> {
    const objectKey = bundleObjectKey(ref);
    const envelope = encryptObject(key, bundleEnvelopeContext(ref), bundle, this.random);
    if ((await this.write(objectKey, envelope, ref.writeId)) === "exists") {
      throw new ArtifactIntegrityError("mismatch");
    }
    this.cache.set(objectKey, envelope);
    return objectKey;
  }

  /** Downloads and decrypts a bundle. The caller zeroizes the returned buffer when done. */
  async getBundle(key: AccountDataKey, ref: BundleRef): Promise<Buffer> {
    const objectKey = bundleObjectKey(ref);
    return this.open(key, bundleEnvelopeContext(ref), await this.read(objectKey, true));
  }

  /**
   * Encrypts and uploads a head snapshot. When an earlier attempt already stored the same commit's
   * snapshot (same commit id, so same content), the existing object is verified and kept.
   */
  async putSnapshot(
    key: AccountDataKey,
    snapshot: DocumentSnapshot,
    writeId: string,
  ): Promise<string> {
    const ref: SnapshotRef = {
      ownerId: key.ownerId,
      taskId: snapshot.taskId,
      commitId: snapshot.commitId,
    };
    const objectKey = snapshotObjectKey(ref);
    const plaintext = encodeSnapshot(snapshot);
    let envelope: Uint8Array;
    try {
      envelope = encryptObject(key, snapshotEnvelopeContext(ref), plaintext, this.random);
    } finally {
      zeroize(plaintext);
    }
    if ((await this.write(objectKey, envelope, writeId)) === "exists") {
      this.cache.delete(objectKey);
      const existing = await this.getSnapshot(key, ref);
      if (markdownDigest(existing.markdown) !== markdownDigest(snapshot.markdown)) {
        throw new ArtifactIntegrityError("mismatch");
      }
      return objectKey;
    }
    this.cache.set(objectKey, envelope);
    return objectKey;
  }

  /** Downloads, decrypts and validates a head snapshot. */
  async getSnapshot(key: AccountDataKey, ref: SnapshotRef): Promise<DocumentSnapshot> {
    const objectKey = snapshotObjectKey(ref);
    const plaintext = this.open(
      key,
      snapshotEnvelopeContext(ref),
      await this.read(objectKey, true),
    );
    try {
      return decodeSnapshot(plaintext, { taskId: ref.taskId, commitId: ref.commitId });
    } finally {
      zeroize(plaintext);
    }
  }

  /** Writes a `document-git` job object; an existing object is left as it is (retried attempts). */
  async putJob(
    key: AccountDataKey,
    ref: JobRef,
    value: unknown,
    writeId: string,
  ): Promise<"created" | "exists"> {
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    try {
      const envelope = encryptObject(key, jobEnvelopeContext(ref), plaintext, this.random);
      return await this.write(jobObjectKey(ref), envelope, writeId);
    } finally {
      zeroize(plaintext);
    }
  }

  /** Reads a job object, or null when it does not exist. */
  async getJob(key: AccountDataKey, ref: JobRef): Promise<unknown> {
    const stored = await this.objects.get(jobObjectKey(ref));
    if (!stored) return null;
    const plaintext = this.open(key, jobEnvelopeContext(ref), stored.body);
    try {
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new ArtifactIntegrityError("malformed");
    } finally {
      zeroize(plaintext);
    }
  }

  async deleteJob(ref: JobRef): Promise<void> {
    await this.objects.delete(jobObjectKey(ref));
  }

  /** Forgets cached ciphertext of a key (for example after deleting the object). */
  forget(objectKey: string): void {
    this.cache.delete(objectKey);
  }

  get objectStore(): ObjectStore {
    return this.objects;
  }
}
