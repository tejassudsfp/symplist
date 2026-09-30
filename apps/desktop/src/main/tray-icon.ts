/**
 * The menu-bar icon, drawn in code.
 *
 * A padlock, closed while the vault is locked and open while it is not, so the state of the vault is
 * readable from the menu bar without opening the panel. It is drawn rather than shipped as a pair of
 * PNG files for the reason the Symplist mark is drawn from arithmetic (`apps/web/src/components/brand/
 * logo.tsx`): the geometry is reviewable, it redraws identically at every scale factor, and a committed
 * binary cannot be read in a diff.
 *
 * The geometry is the mockup's, on its own 24-unit grid — body `rect x=4 y=11 w=16 h=10 rx=2`, shackle
 * `M8 11V7.5a4 4 0 0 1 8 0V11`, stroke 2.2, round caps — scaled to whatever pixel size is asked for.
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

export interface PadlockOptions {
  /** The open padlock: the vault is unlocked. */
  readonly open?: boolean;
  /** The bitmap's edge in pixels. 16 is one menu-bar point; 32 is the same icon at 2×. */
  readonly size: number;
}

/** Signed distance to a rounded rectangle's outline, negative inside it. */
function roundedRect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const dx = Math.abs(px - cx) - (halfWidth - radius);
  const dy = Math.abs(py - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return Math.min(Math.max(dx, dy), 0) + outside - radius;
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

/**
 * The padlock's signed distance field on the 24-unit grid. Negative inside the drawn stroke.
 *
 * The body is a stroked rounded rectangle — `Math.abs` of the filled distance turns a fill into an
 * outline — and the shackle is the upper half of a circle with a leg on each side, or one leg when the
 * lock is open and the shackle has swung clear.
 */
export function padlockDistance(x: number, y: number, open: boolean): number {
  const half = STROKE / 2;
  const body = Math.abs(roundedRect(x, y, 12, 16, 8, 5, 2)) - half;

  // The arc's centre: on the lock's axis when closed, shifted right when the shackle is open.
  const arcX = open ? 14.5 : 12;
  const arcY = 7.5;
  const radius = 4;
  const arc =
    y <= arcY ? Math.abs(Math.hypot(x - arcX, y - arcY) - radius) - half : Number.POSITIVE_INFINITY;

  // The left leg reaches the body; the right one only does when the shackle is closed.
  const legs = open
    ? capsule(x, y, arcX - radius, arcY, arcX - radius, 11, half)
    : Math.min(
        capsule(x, y, arcX - radius, arcY, arcX - radius, 11, half),
        capsule(x, y, arcX + radius, arcY, arcX + radius, 11, half),
      );

  return Math.min(body, arc, legs);
}

/** Non-premultiplied RGBA for one padlock: black everywhere, with the shape in the alpha channel. */
export function padlockRgba(options: PadlockOptions): Uint8Array {
  const { size } = options;
  if (!Number.isInteger(size) || size < 8 || size > 256) {
    throw new Error(`tray icon size out of range: ${String(size)}`);
  }
  const open = options.open ?? false;
  const scale = size / GRID;
  const rgba = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      // The pixel's centre, in grid units.
      const distance = padlockDistance((column + 0.5) / scale, (row + 0.5) / scale, open);
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
export function padlockDataUrl(options: PadlockOptions): string {
  const png = encodePng(options.size, options.size, padlockRgba(options));
  return `data:image/png;base64,${png.toString("base64")}`;
}
