import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, markDataUrl, markDistance, markRgba } from "./tray-icon.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The alpha channel as a grid, which is the only channel the icon uses. */
function alphaGrid(size: number): number[][] {
  const rgba = markRgba({ size });
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => rgba[(row * size + column) * 4 + 3] ?? 0),
  );
}

describe("the menu-bar mark", () => {
  it("draws a dot and a line on each of the three rows", () => {
    // The brand geometry on a 24-unit grid: dots of r 1.35 centred at x 4.7, rows at y 6.5 / 12 / 17.5,
    // lines from x 9.1 with a 2.2 stroke.
    for (const y of [6.5, 12, 17.5]) {
      expect(markDistance(4.7, y)).toBeLessThan(0);
      expect(markDistance(9.1, y)).toBeLessThan(0);
    }
  });

  it("steps the lines down 11.0 / 7.4 / 3.8, which is what makes it the mark and not three bars", () => {
    // Just inside each line's end is drawn; just past it is not. A line that kept its length would
    // make the mark a stack of equal bars, which is the one thing it must never look like.
    const ends = [
      { y: 6.5, end: 20.1 },
      { y: 12, end: 16.5 },
      { y: 17.5, end: 12.9 },
    ];
    for (const { y, end } of ends) {
      expect(markDistance(end - 0.2, y)).toBeLessThan(0);
      expect(markDistance(end + 1.6, y)).toBeGreaterThan(0);
    }
    // And each row really is shorter than the one above it.
    expect(ends[0]?.end).toBeGreaterThan(ends[1]?.end ?? 0);
    expect(ends[1]?.end).toBeGreaterThan(ends[2]?.end ?? 0);
  });

  it("leaves the gap between the dot and its line undrawn", () => {
    // The dot ends at x 6.05 and the line starts at 9.1 less its 1.1 cap, so the middle of that gap is
    // empty. Losing it would weld the dot to the line and flatten the mark into a tally.
    for (const y of [6.5, 12, 17.5]) {
      expect(markDistance(7.4, y)).toBeGreaterThan(0);
    }
  });

  it("leaves the rows separated", () => {
    expect(markDistance(4.7, 9.25)).toBeGreaterThan(0);
    expect(markDistance(4.7, 14.75)).toBeGreaterThan(0);
  });

  it("is black with the shape in the alpha channel, which is what a template image is", () => {
    const rgba = markRgba({ size: 16 });
    for (let index = 0; index < rgba.length; index += 4) {
      expect(rgba[index]).toBe(0);
      expect(rgba[index + 1]).toBe(0);
      expect(rgba[index + 2]).toBe(0);
    }
    expect([...rgba.filter((_, index) => index % 4 === 3)].some((alpha) => alpha > 250)).toBe(true);
  });

  it("antialiases rather than stair-stepping, so the icon is legible at one menu-bar point", () => {
    const partial = alphaGrid(16)
      .flat()
      .filter((alpha) => alpha > 0 && alpha < 255);
    expect(partial.length).toBeGreaterThan(20);
  });

  it("leaves the corners of the bitmap empty at every size", () => {
    for (const size of [16, 32, 64]) {
      const grid = alphaGrid(size);
      expect(grid[0]?.[0]).toBe(0);
      expect(grid[0]?.[size - 1]).toBe(0);
      expect(grid[size - 1]?.[0]).toBe(0);
      expect(grid[size - 1]?.[size - 1]).toBe(0);
    }
  });

  it("redraws the same shape at 2×", () => {
    // The icon is geometry rather than a bitmap, so the 2× representation is the same drawing and not
    // an upscale: the top row's line reaches further right than the bottom row's at both sizes.
    for (const size of [16, 32]) {
      const grid = alphaGrid(size);
      const column = Math.round((18 / 24) * size);
      expect(grid[Math.round((6.5 / 24) * size)]?.[column]).toBeGreaterThan(0);
      expect(grid[Math.round((17.5 / 24) * size)]?.[column]).toBe(0);
    }
  });

  it("refuses a size that is not a sensible bitmap", () => {
    expect(() => markRgba({ size: 3 })).toThrow();
    expect(() => markRgba({ size: 16.5 })).toThrow();
    expect(() => markRgba({ size: 4096 })).toThrow();
  });
});

describe("the PNG it is handed to nativeImage as", () => {
  it("writes a signature, an IHDR with the size, and an IEND", () => {
    const png = encodePng(16, 16, markRgba({ size: 16 }));
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
    const rgba = markRgba({ size: 16 });
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
    const url = markDataUrl({ size: 16 });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const decoded = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    expect(decoded.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("draws the 2× representation at twice the pixels, not the same bitmap scaled", () => {
    expect(markDataUrl({ size: 16 })).not.toBe(markDataUrl({ size: 32 }));
    expect(encodePng(32, 32, markRgba({ size: 32 })).readUInt32BE(16)).toBe(32);
  });
});
