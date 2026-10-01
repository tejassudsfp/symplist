/**
 * The menu-bar icon, drawn in code.
 *
 * The Symplist mark — three rows of a dot and a line, stepping down. It is drawn from arithmetic for
 * the same reason `apps/web/src/components/brand/logo.tsx` is: the geometry is reviewable, it redraws
 * identically at every scale factor, and a committed binary cannot be read in a diff.
 *
 * The geometry is the brand's, on its own 24-unit grid — dots of r 1.35 at x 4.7, rows at y 6.5 / 12 /
 * 17.5, lines from x 9.1 stepping 11.0 / 7.4 / 3.8, stroke 2.2 with round caps.
 *
 * It does not change with the vault's state. An earlier version drew a padlock that opened and closed,
 * which read the state from the menu bar but put a second mark in front of people; the panel says
 * whether the vault is open, and the menu bar says whose app this is.
 *
 * Every pixel is black with an alpha, which is exactly what macOS wants from a template image: the
 * system recolours it for a light or dark menu bar and for the highlight state, so the icon needs no
 * colour of its own and no second asset. That also makes the channel order irrelevant.
 *
 * Nothing here touches Electron, so the shape is unit-tested under plain Node.
 */

import { deflateSync } from "node:zlib";

/** The design grid the geometry is expressed on. */
const GRID = 24;

/** The mockup's stroke, on the same grid. */
const STROKE = 2.2;

export interface MarkOptions {
  /** The bitmap's edge in pixels. 16 is one menu-bar point; 32 is the same icon at 2×. */
  readonly size: number;
}

/** Signed distance to a line segment with round caps, negative inside it. */
function capsule(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  halfWidth: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const length = vx * vx + vy * vy;
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / length));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t)) - halfWidth;
}

/** The three rows: the y each sits on, and where its line ends. */
const ROWS: readonly { readonly y: number; readonly end: number }[] = [
  { y: 6.5, end: 20.1 },
  { y: 12, end: 16.5 },
  { y: 17.5, end: 12.9 },
];

/** The dots' centre line and radius, and where every line begins. */
const DOT_X = 4.7;
const DOT_R = 1.35;
const LINE_X = 9.1;

/**
 * The mark's signed distance field on the 24-unit grid. Negative inside the drawn shape.
 *
 * Six primitives unioned: a filled disc and a round-capped line for each row. A round cap is a capsule,
 * which is what gives the line ends their radius without a separate arc.
 */
export function markDistance(x: number, y: number): number {
  const half = STROKE / 2;
  let distance = Number.POSITIVE_INFINITY;
  for (const row of ROWS) {
    const dot = Math.hypot(x - DOT_X, y - row.y) - DOT_R;
    const line = capsule(x, y, LINE_X, row.y, row.end, row.y, half);
    distance = Math.min(distance, dot, line);
  }
  return distance;
}

/** Non-premultiplied RGBA for the mark: black everywhere, with the shape in the alpha channel. */
export function markRgba(options: MarkOptions): Uint8Array {
  const { size } = options;
  if (!Number.isInteger(size) || size < 8 || size > 256) {
    throw new Error(`tray icon size out of range: ${String(size)}`);
  }
  const scale = size / GRID;
  const rgba = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      // The pixel's centre, in grid units.
      const distance = markDistance((column + 0.5) / scale, (row + 0.5) / scale);
      // One pixel of antialiasing across the edge, which is why the distance is converted back.
      const coverage = Math.min(1, Math.max(0, 0.5 - distance * scale));
      rgba[(row * size + column) * 4 + 3] = Math.round(coverage * 255);
    }
  }
  return rgba;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.alloc(4 + data.length);
  body.write(type, 0, "ascii");
  body.set(data, 4);
  const framed = Buffer.alloc(body.length + 8);
  framed.writeUInt32BE(data.length, 0);
  body.copy(framed, 4);
  framed.writeUInt32BE(crc32(body), framed.length - 4);
  return framed;
}

/** A PNG for an 8-bit RGBA bitmap. Filter 0 on every scanline: the image is tiny and deflate is enough. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) {
    const offset = row * (width * 4 + 1);
    raw[offset] = 0;
    raw.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), offset + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * The icon as a data URL, which is the form `nativeImage` accepts for both the base representation and
 * the 2× one (`addRepresentation({ scaleFactor, dataURL })`).
 */
export function markDataUrl(options: MarkOptions): string {
  const png = encodePng(options.size, options.size, markRgba(options));
  return `data:image/png;base64,${png.toString("base64")}`;
}
