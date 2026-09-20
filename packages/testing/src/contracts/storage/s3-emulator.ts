import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/** A request the emulator received. */
export interface RecordedS3Request {
  readonly method: string;
  readonly bucket: string;
  /** Decoded object key, or empty for bucket-level requests. */
  readonly key: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
}

interface StoredEmulatorObject {
  readonly body: Buffer;
  readonly etag: string;
  readonly contentType: string;
  readonly metadata: Record<string, string>;
  readonly lastModified: Date;
}

export interface S3Fault {
  readonly status: number;
  readonly code: string;
  /** Matches requests by method; defaults to any. */
  readonly method?: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`;
}

/**
 * A minimal S3-compatible server implementing the R2 behavior the ObjectStore relies on:
 * `PutObject` with `If-None-Match: *` (412 when the key exists), `GetObject`, `HeadObject`,
 * `DeleteObject`, and `ListObjectsV2` with continuation tokens. Path-style addressing only.
 */
export class S3Emulator {
  readonly requests: RecordedS3Request[] = [];
  private readonly objects = new Map<string, StoredEmulatorObject>();
  private readonly faults: S3Fault[] = [];
  private server: Server | undefined;
  private port = 0;

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => this.handle(request, Buffer.concat(chunks), response));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  /** Fails the next matching request with the given status and S3 error code. */
  failNext(fault: S3Fault): void {
    this.faults.push(fault);
  }

  /** Stores an object directly, bypassing the API (for oversized-body tests). */
  seed(bucket: string, key: string, body: Uint8Array, metadata: Record<string, string> = {}): void {
    this.objects.set(`${bucket}/${key}`, {
      body: Buffer.from(body),
      etag: createHash("md5").update(body).digest("hex"),
      contentType: "application/octet-stream",
      metadata,
      lastModified: new Date(),
    });
  }

  private handle(request: IncomingMessage, body: Buffer, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://emulator");
    const [, bucket = "", ...rest] = url.pathname.split("/");
    const key = rest.map((part) => decodeURIComponent(part)).join("/");
    const method = request.method ?? "GET";
    this.requests.push({ method, bucket, key, query: url.searchParams, headers: request.headers });

    const faultIndex = this.faults.findIndex(
      (fault) => fault.method === undefined || fault.method === method,
    );
    if (faultIndex !== -1) {
      const [fault] = this.faults.splice(faultIndex, 1);
      if (fault) {
        response.writeHead(fault.status, { "content-type": "application/xml" });
        response.end(method === "HEAD" ? undefined : errorXml(fault.code, "Injected fault"));
        return;
      }
    }

    const id = `${bucket}/${key}`;
    if (method === "PUT" && key) {
      if (request.headers["if-none-match"] === "*" && this.objects.has(id)) {
        response.writeHead(412, { "content-type": "application/xml" });
        response.end(
          errorXml(
            "PreconditionFailed",
            "At least one of the pre-conditions you specified did not hold",
          ),
        );
        return;
      }
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (name.startsWith("x-amz-meta-") && typeof value === "string")
          metadata[name.slice(11)] = value;
      }
      const etag = createHash("md5").update(body).digest("hex");
      this.objects.set(id, {
        body,
        etag,
        contentType: String(request.headers["content-type"] ?? "application/octet-stream"),
        metadata,
        lastModified: new Date(),
      });
      response.writeHead(200, { etag: `"${etag}"` });
      response.end();
      return;
    }

    if ((method === "GET" || method === "HEAD") && key) {
      const stored = this.objects.get(id);
      if (!stored) {
        response.writeHead(404, { "content-type": "application/xml" });
        response.end(
          method === "HEAD"
            ? undefined
            : errorXml("NoSuchKey", "The specified key does not exist."),
        );
        return;
      }
      const headers: Record<string, string> = {
        "content-length": String(stored.body.byteLength),
        "content-type": stored.contentType,
        etag: `"${stored.etag}"`,
        "last-modified": stored.lastModified.toUTCString(),
      };
      for (const [name, value] of Object.entries(stored.metadata))
        headers[`x-amz-meta-${name}`] = value;
      response.writeHead(200, headers);
      response.end(method === "HEAD" ? undefined : stored.body);
      return;
    }

    if (method === "DELETE" && key) {
      this.objects.delete(id);
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "GET" && !key && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000");
      const token = url.searchParams.get("continuation-token");
      const after = token ? Buffer.from(token, "base64url").toString("utf8") : undefined;
      const keys = [...this.objects.keys()]
        .filter((entry) => entry.startsWith(`${bucket}/`))
        .map((entry) => entry.slice(bucket.length + 1))
        .filter((entry) => entry.startsWith(prefix) && (after === undefined || entry > after))
        .sort();
      const page = keys.slice(0, maxKeys);
      const truncated = keys.length > page.length;
      const contents = page
        .map((entry) => {
          const stored = this.objects.get(`${bucket}/${entry}`) as StoredEmulatorObject;
          return `<Contents><Key>${xmlEscape(entry)}</Key><LastModified>${stored.lastModified.toISOString()}</LastModified><ETag>&quot;${stored.etag}&quot;</ETag><Size>${stored.body.byteLength}</Size></Contents>`;
        })
        .join("");
      const next = truncated
        ? `<NextContinuationToken>${Buffer.from(page[page.length - 1] as string).toString("base64url")}</NextContinuationToken>`
        : "";
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`,
      );
      return;
    }

    response.writeHead(501, { "content-type": "application/xml" });
    response.end(errorXml("NotImplemented", "The emulator does not implement this request"));
  }
}
