import type { IncomingMessage } from "node:http";

export type RawBodyResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: "too_large" | "aborted" };

/**
 * Reads the exact request bytes with a hard limit. Internal requests use a media type the global JSON
 * parser ignores, so the stream is still unread when the controller runs and the signature covers
 * exactly what arrived (§6.2).
 */
export async function readRawBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<RawBodyResult> {
  const declared = request.headers["content-length"];
  if (
    declared !== undefined &&
    (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > limitBytes)
  ) {
    request.resume();
    return { ok: false, reason: "too_large" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > limitBytes) {
        request.resume();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(bytes);
    }
  } catch {
    return { ok: false, reason: "aborted" };
  }
  return { ok: true, body: Buffer.concat(chunks, size) };
}

/** The media type without parameters, lower-cased. */
export function mediaType(request: IncomingMessage): string | undefined {
  const header = request.headers["content-type"];
  return typeof header === "string" ? header.split(";")[0]?.trim().toLowerCase() : undefined;
}
