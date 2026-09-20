import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export class ClientMetadataError extends Error {
  constructor() {
    super("oauth.invalid_client_metadata");
    this.name = "ClientMetadataError";
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2002::", 16],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function publicMetadataAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  return false;
}

function safeUrl(value: string): URL {
  try {
    if (value.length > 2048 || /[\s\\]/.test(value)) throw new ClientMetadataError();
    const url = new URL(value);
    if (url.username || url.password || url.hash) throw new ClientMetadataError();
    return url;
  } catch {
    throw new ClientMetadataError();
  }
}

export function validRedirectUri(value: string): boolean {
  try {
    const url = safeUrl(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/** HTTPS compares exact strings; only registered HTTP loopback ports may vary. */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (!validRedirectUri(requested)) return false;
  if (registered.includes(requested)) return true;
  const target = safeUrl(requested);
  if (target.protocol !== "http:") return false;
  target.port = "";
  return registered.some((entry) => {
    if (!validRedirectUri(entry)) return false;
    const candidate = safeUrl(entry);
    if (candidate.protocol !== "http:") return false;
    candidate.port = "";
    return candidate.href === target.href;
  });
}

export interface OAuthClientMetadata {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly applicationType: "native" | "web";
  readonly metadataHost: string;
  readonly loopbackOnly: boolean;
}

export function parseClientMetadata(value: unknown, clientId: string): OAuthClientMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientMetadataError();
  const data = value as Record<string, unknown>;
  if (
    data.client_id !== clientId ||
    typeof data.client_name !== "string" ||
    !data.client_name.trim() ||
    data.client_name.length > 200 ||
    !Array.isArray(data.redirect_uris) ||
    !data.redirect_uris.length ||
    data.redirect_uris.length > 20 ||
    data.redirect_uris.some((uri) => typeof uri !== "string" || !validRedirectUri(uri)) ||
    (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none") ||
    (data.application_type !== undefined &&
      data.application_type !== "native" &&
      data.application_type !== "web")
  )
    throw new ClientMetadataError();
  const redirects = data.redirect_uris as string[];
  return Object.freeze({
    clientId,
    name: data.client_name.trim(),
    redirectUris: Object.freeze([...new Set(redirects)]),
    applicationType: data.application_type === "native" ? "native" : "web",
    metadataHost: safeUrl(clientId).hostname,
    loopbackOnly: redirects.every((uri) => safeUrl(uri).protocol === "http:"),
  });
}

export interface MetadataTransport {
  resolve(hostname: string): Promise<readonly { address: string; family: number }[]>;
  get(
    url: URL,
    address: { address: string; family: number },
    signal: AbortSignal,
  ): Promise<{ body: string; maxAge: number }>;
}

/** TLS validates the original hostname, while DNS lookup is pinned to the already-vetted address. */
export const nodeMetadataTransport: MetadataTransport = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  get: (url, address, signal) =>
    new Promise((resolve, reject) => {
      const fail = () => reject(new ClientMetadataError());
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          signal,
          headers: { accept: "application/json", "accept-encoding": "identity" },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: address.address, family: address.family }]);
            else callback(null, address.address, address.family);
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity") ||
            !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(
              response.headers["content-type"] ?? "",
            )
          ) {
            response.destroy();
            fail();
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > 10_240) {
              response.destroy();
              fail();
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => {
            const control = response.headers["cache-control"] ?? "";
            const match = /(?:^|,)\s*max-age=(\d+)(?:\s*,|$)/i.exec(control);
            const maxAge = /(?:no-store|no-cache)/i.test(control)
              ? 0
              : Math.min(86400, Number(match?.[1] ?? 300));
            resolve({ body: Buffer.concat(chunks).toString("utf8"), maxAge });
          });
        },
      );
      req.on("error", fail);
      req.end();
    }),
};

export class ClientMetadataLoader {
  private readonly cache = new Map<string, { until: number; metadata: OAuthClientMetadata }>();
  constructor(
    private readonly transport: MetadataTransport = nodeMetadataTransport,
    private readonly now = Date.now,
  ) {}

  async load(clientId: string): Promise<OAuthClientMetadata> {
    const url = safeUrl(clientId);
    if (
      url.protocol !== "https:" ||
      (url.port && url.port !== "443") ||
      url.href !== clientId ||
      url.hostname.endsWith(".") ||
      url.hostname === "localhost"
    )
      throw new ClientMetadataError();
    const cached = this.cache.get(clientId);
    if (cached && cached.until > this.now()) return cached.metadata;
    try {
      const signal = AbortSignal.timeout(5000);
      const deadline = new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new ClientMetadataError()), { once: true }),
      );
      const addresses = await Promise.race([
        this.transport.resolve(url.hostname.replace(/^\[|\]$/g, "")),
        deadline,
      ]);
      if (!addresses.length || addresses.some((entry) => !publicMetadataAddress(entry.address)))
        throw new ClientMetadataError();
      const pinned = addresses[0];
      if (!pinned) throw new ClientMetadataError();
      const response = await Promise.race([this.transport.get(url, pinned, signal), deadline]);
      if (Buffer.byteLength(response.body) > 10_240) throw new ClientMetadataError();
      const metadata = parseClientMetadata(JSON.parse(response.body), clientId);
      if (this.cache.size >= 500) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      if (response.maxAge > 0)
        this.cache.set(clientId, {
          until: this.now() + Math.min(86400, response.maxAge) * 1000,
          metadata,
        });
      return metadata;
    } catch {
      throw new ClientMetadataError();
    }
  }
}
