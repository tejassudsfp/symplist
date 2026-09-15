import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Request } from "express";

/** A valid IP address with IPv4-mapped IPv6 addresses unmapped, or null. */
function normalizeAddress(ip: unknown): string | null {
  if (typeof ip !== "string") return null;
  const unmapped = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return isIP(unmapped) === 0 ? null : unmapped;
}

/**
 * The client address Express computed under `trust proxy = TRUST_PROXY_HOPS` (§5.8). With `0` it is
 * the socket peer and `X-Forwarded-For` is ignored; with `n` it is the address `n` hops from the
 * right of the header, so values a client prepends never change it.
 */
export function clientIp(req: Request): string | null {
  return normalizeAddress(req.ip ?? req.socket?.remoteAddress);
}

/**
 * The `X-Forwarded-For` entries from right to left, split exactly as Express's `proxy-addr` 2.0.7 does
 * through `forwarded` 0.2.0: commas separate entries, spaces around them are dropped and empty entries
 * are skipped.
 */
export function forwardedForEntries(header: string | readonly string[] | undefined): string[] {
  const text = Array.isArray(header) ? header.join(",") : typeof header === "string" ? header : "";
  const entries: string[] = [];
  let end = text.length;
  let start = text.length;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    switch (text.charCodeAt(index)) {
      case 0x20:
        if (start === end) start = end = index;
        break;
      case 0x2c:
        if (start !== end) entries.push(text.slice(start, end));
        start = end = index;
        break;
      default:
        start = index;
        break;
    }
  }
  if (start !== end) entries.push(text.slice(start, end));
  return entries;
}

/**
 * The client address of a request Express never saw, such as a WebSocket upgrade (§5.8, §7), under
 * the same rule as `app.set("trust proxy", TRUST_PROXY_HOPS)`: the socket peer followed by the
 * `X-Forwarded-For` entries from right to left, and of those the one `TRUST_PROXY_HOPS` hops from the
 * peer (the leftmost when the header is shorter). A client-supplied prefix never changes the result.
 */
export function upgradeClientIp(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxyHops: number,
): string | null {
  if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new RangeError("TRUST_PROXY_HOPS must be a non-negative integer");
  }
  const addresses = [
    req.socket?.remoteAddress,
    ...forwardedForEntries(req.headers["x-forwarded-for"]),
  ];
  return normalizeAddress(addresses[Math.min(trustProxyHops, addresses.length - 1)]);
}

/** The first four groups of a valid IPv6 address, zero-padded. */
function ipv6NetworkGroups(address: string): string[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (isIP(tail) === 4) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  return groups.slice(0, 4).map((group) => group.padStart(4, "0"));
}

/**
 * The key an in-memory IP bucket counts under: the IPv4 address, or the /64 network of an IPv6
 * address, because one client controls a whole /64 and could otherwise rotate addresses freely.
 */
export function ipBucketKey(ip: string | null): string {
  if (ip === null) return "unknown";
  const version = isIP(ip);
  if (version === 4) return ip;
  const groups = version === 6 ? ipv6NetworkGroups(ip) : null;
  return groups ? `${groups.join(":")}::/64` : "unknown";
}
