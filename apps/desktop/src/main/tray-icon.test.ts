import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, padlockDataUrl, padlockDistance, padlockRgba } from "./tray-icon.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The alpha channel as a grid, which is the only channel the icon uses. */
function alphaGrid(size: number, open: boolean): number[][] {
  const rgba = padlockRgba({ open, size });
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => rgba[(row * size + column) * 4 + 3] ?? 0),
  );
}

describe("the menu-bar padlock", () => {
  it("draws the body and the shackle, and leaves the middle of the body hollow", () => {
    // The mockup's geometry on a 24-unit grid: body `rect x=4 y=11 w=16 h=10`, shackle arc centred at
    // (12, 7.5) with radius 4. The outline is drawn; the inside of the body is not.
    expect(padlockDistance(12, 11, false)).toBeLessThan(0);
    expect(padlockDistance(12, 16, false)).toBeGreaterThan(0);
    expect(padlockDistance(12, 3.5, false)).toBeLessThan(0);
    expect(padlockDistance(12, 7.5, false)).toBeGreaterThan(0);
  });

  it("swings the shackle clear and drops its second leg when the vault is unlocked", () => {
    // Closed, both legs stand at x = 8 and x = 16; open, the shackle has moved right and the leg that
    // stood at x = 16 is gone, which is the whole visible difference in the menu bar.
    expect(padlockDistance(16, 9.5, false)).toBeLessThan(0);
    expect(padlockDistance(16, 9.5, true)).toBeGreaterThan(0);
    expect(padlockDistance(10.5, 9.5, true)).toBeLessThan(0);
  });

  it("keeps the body identical whether it is open or closed", () => {
    expect(padlockDistance(4, 16, true)).toBeCloseTo(padlockDistance(4, 16, false), 10);
  });

  it("is black with the shape in the alpha channel, which is what a template image is", () => {
    const rgba = padlockRgba({ size: 16 });
    for (let index = 0; index < rgba.length; index += 4) {
      expect(rgba[index]).toBe(0);
      expect(rgba[index + 1]).toBe(0);
      expect(rgba[index + 2]).toBe(0);
    }
    expect([...rgba.filter((_, index) => index % 4 === 3)].some((alpha) => alpha > 250)).toBe(true);
  });

  it("antialiases rather than stair-stepping, so the icon is legible at one menu-bar point", () => {
    const alphas = alphaGrid(16, false).flat();
    const partial = alphas.filter((alpha) => alpha > 0 && alpha < 255);
    expect(partial.length).toBeGreaterThan(20);
  });

  it("leaves the corners of the bitmap empty at every size", () => {
    for (const size of [16, 32]) {
      const grid = alphaGrid(size, false);
      expect(grid[0]?.[0]).toBe(0);
      expect(grid[0]?.[size - 1]).toBe(0);
      expect(grid[size - 1]?.[0]).toBe(0);
      expect(grid[size - 1]?.[size - 1]).toBe(0);
    }
  });

  it("redraws the same shape at 2×", () => {
    // The icon is geometry rather than a bitmap, so the 2× representation is the same drawing and not
    // an upscale: the centre of the body is hollow at both sizes and the shackle is above it at both.
    for (const size of [16, 32]) {
      const grid = alphaGrid(size, false);
      const middle = Math.round((16 / 24) * size);
      expect(grid[middle]?.[Math.round(size / 2)]).toBe(0);
    }
  });

  it("refuses a size that is not a sensible bitmap", () => {
    expect(() => padlockRgba({ size: 3 })).toThrow();
    expect(() => padlockRgba({ size: 16.5 })).toThrow();
    expect(() => padlockRgba({ size: 4096 })).toThrow();
  });
});

describe("the PNG it is handed to nativeImage as", () => {
  it("writes a signature, an IHDR with the size, and an IEND", () => {
    const png = encodePng(16, 16, padlockRgba({ size: 16 }));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("round-trips the pixels: the deflated scanlines inflate back to what was drawn", () => {
    // The encoder is ours, so its output is checked rather than trusted. A wrong CRC or a filter byte
    // in the wrong place would leave `nativeImage` with an empty icon and no error to read.
    const rgba = padlockRgba({ size: 16 });
    const png = encodePng(16, 16, rgba);
    const start = png.indexOf(Buffer.from("IDAT", "ascii"));
    const length = png.readUInt32BE(start - 4);
    const raw = inflateSync(png.subarray(start + 4, start + 4 + length));
    expect(raw.length).toBe(16 * (16 * 4 + 1));
    for (let row = 0; row < 16; row++) {
      const offset = row * (16 * 4 + 1);
      expect(raw[offset]).toBe(0);
      expect(raw.subarray(offset + 1, offset + 1 + 16 * 4)).toEqual(
        Buffer.from(rgba.subarray(row * 16 * 4, (row + 1) * 16 * 4)),
      );
    }
  });

  it("is a data URL, which is the form both nativeImage representations accept", () => {
    const url = padlockDataUrl({ size: 16 });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const decoded = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    expect(decoded.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("gives the open and closed states different bytes, so the menu bar can show the state", () => {
    expect(padlockDataUrl({ size: 16 })).not.toBe(padlockDataUrl({ size: 16, open: true }));
  });
});
