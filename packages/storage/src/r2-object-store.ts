import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
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
  ObjectStore,
  PutObjectInput,
  PutObjectResult,
  StoredObject,
} from "./object-store.ts";

export type R2Jurisdiction = "default" | "eu" | "fedramp";

export interface R2ObjectStoreOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Jurisdictional buckets are reachable only through their own endpoint. */
  readonly jurisdiction?: R2Jurisdiction;
  /** Overrides the R2 endpoint (tests use a local S3 emulator). */
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  /** Cap on bodies written and read; defaults to 100 MiB. */
  readonly maxBodyBytes?: number;
  /** SDK attempts per request (default 3). Conditional puts stay safe: a retried put is resolved by `write-id`. */
  readonly maxAttempts?: number;
}

const accountIdPattern = /^[0-9a-f]{32}$/i;
const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The S3 client settings R2 requires (§1): region `auto` and checksums only when required. */
export function r2ClientConfig(options: R2ObjectStoreOptions): S3ClientConfig {
  if (!options.endpoint && !accountIdPattern.test(options.accountId)) {
    throw new StorageError(
      "storage.config_invalid",
      "CLOUDFLARE_ACCOUNT_ID must be a 32-character hex id",
    );
  }
  if (!bucketPattern.test(options.bucket)) {
    throw new StorageError("storage.config_invalid", "R2_BUCKET is not a valid bucket name");
  }
  if (!options.accessKeyId || !options.secretAccessKey) {
    throw new StorageError("storage.config_invalid", "R2 credentials are required");
  }
  const jurisdiction = options.jurisdiction ?? "default";
  const host =
    jurisdiction === "default"
      ? "r2.cloudflarestorage.com"
      : `${jurisdiction}.r2.cloudflarestorage.com`;
  return {
    region: "auto",
    endpoint: options.endpoint ?? `https://${options.accountId}.${host}`,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: options.maxAttempts,
  };
}

interface S3ErrorShape {
  readonly name?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function statusOf(error: unknown): number | undefined {
  return (error as S3ErrorShape | undefined)?.$metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = (error as S3ErrorShape | undefined)?.name;
  return statusOf(error) === 404 || name === "NoSuchKey" || name === "NotFound";
}

/** Maps SDK failures to stable codes without request details (§8.3). */
function storageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const status = statusOf(error);
  const name = (error as S3ErrorShape | undefined)?.name;
  if (status === 401 || status === 403) {
    return new StorageError(
      "storage.unauthorized",
      `R2 rejected the credentials (HTTP ${status})`,
      status,
    );
  }
  if (status === 429 || name === "SlowDown") {
    return new StorageError("storage.rate_limited", "R2 rate limited the request", status);
  }
  if (status === undefined || status >= 500) {
    return new StorageError("storage.unavailable", "R2 is unavailable", status);
  }
  return new StorageError("storage.rejected", `R2 rejected the request (HTTP ${status})`, status);
}

function stripQuotes(etag: string | undefined): string | undefined {
  return etag?.replace(/^"|"$/g, "");
}

async function readBounded(body: unknown, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const stream = body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      stream.destroy?.();
      throw new StorageError("storage.too_large", "Object body exceeds the size limit");
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Cloudflare R2 through the S3 API (§1): conditional creates with `If-None-Match: *`, HTTP 412
 * resolved by a `HeadObject` check of the `write-id` metadata, one `DeleteObject` per key, prefix
 * listing with continuation tokens, and bounded bodies.
 */
export class R2ObjectStore implements ObjectStore {
  readonly client: S3Client;
  private readonly bucket: string;
  private readonly maxBodyBytes: number;

  constructor(options: R2ObjectStoreOptions) {
    this.client = new S3Client(r2ClientConfig(options));
    this.bucket = options.bucket;
    this.maxBodyBytes = options.maxBodyBytes ?? OBJECT_STORE_LIMITS.defaultMaxBodyBytes;
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const key = assertObjectKey(input.key);
    const body = assertBody(input.body, this.maxBodyBytes);
    const metadata = assertMetadata(input.metadata);
    try {
      const output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: input.contentType ?? "application/octet-stream",
          IfNoneMatch: input.ifNoneMatch,
          Metadata: { ...metadata },
        }),
      );
      return { status: "created", etag: stripQuotes(output.ETag) };
    } catch (error) {
      const status = statusOf(error);
      if (input.ifNoneMatch === "*" && (status === 412 || status === 409)) {
        return this.resolveConditionalConflict(key, metadata[WRITE_ID_METADATA_KEY], status);
      }
      throw storageError(error);
    }
  }

  /**
   * 412 means an object exists at the key. It may be this write's own earlier attempt (for example
   * an SDK retry after a lost response), which the stored `write-id` proves.
   */
  private async resolveConditionalConflict(
    key: string,
    writeId: string | undefined,
    status: number,
  ): Promise<PutObjectResult> {
    if (status === 412 && writeId === undefined) return { status: "exists" };
    const head = await this.head(key);
    if (head) {
      return writeId !== undefined && head.metadata[WRITE_ID_METADATA_KEY] === writeId
        ? { status: "created", etag: head.etag }
        : { status: "exists" };
    }
    // 412 with the object already gone again still means another write held the key.
    if (status === 412) return { status: "exists" };
    throw new StorageError(
      "storage.conflict",
      "A concurrent conditional write is in progress",
      status,
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    assertObjectKey(key);
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (output.ContentLength !== undefined && output.ContentLength > this.maxBodyBytes) {
        (output.Body as { destroy?: () => void } | undefined)?.destroy?.();
        throw new StorageError("storage.too_large", "Object body exceeds the size limit");
      }
      const body = await readBounded(output.Body, this.maxBodyBytes);
      return {
        key,
        size: body.byteLength,
        etag: stripQuotes(output.ETag),
        uploadedAt: output.LastModified?.getTime(),
        metadata: { ...(output.Metadata ?? {}) },
        contentType: output.ContentType,
        body,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw storageError(error);
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    try {
      const output = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        size: output.ContentLength ?? 0,
        etag: stripQuotes(output.ETag),
        uploadedAt: output.LastModified?.getTime(),
        metadata: { ...(output.Metadata ?? {}) },
        contentType: output.ContentType,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw storageError(error);
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw storageError(error);
    }
  }

  async list(input: ListObjectsInput): Promise<ListObjectsResult> {
    const prefix = assertPrefix(input.prefix);
    const limit = listLimit(input);
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor === "")) {
      throw new StorageError("storage.invalid_cursor", "Invalid list cursor");
    }
    try {
      const output = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: limit,
          ContinuationToken: input.cursor,
        }),
      );
      const objects: ObjectHead[] = (output.Contents ?? []).flatMap((entry) =>
        entry.Key === undefined
          ? []
          : [
              {
                key: entry.Key,
                size: entry.Size ?? 0,
                etag: stripQuotes(entry.ETag),
                uploadedAt: entry.LastModified?.getTime(),
                metadata: {},
              },
            ],
      );
      return output.IsTruncated && output.NextContinuationToken
        ? { objects, cursor: output.NextContinuationToken }
        : { objects };
    } catch (error) {
      throw storageError(error);
    }
  }
}

export function createR2ObjectStore(options: R2ObjectStoreOptions): R2ObjectStore {
  return new R2ObjectStore(options);
}
