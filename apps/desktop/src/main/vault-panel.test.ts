import { describe, expect, it } from "vitest";
import {
  appPathFor,
  clampPanelHeight,
  initialVaultPanelState,
  PANEL_MAX_HEIGHT,
  PANEL_MIN_HEIGHT,
  PANEL_WIDTH,
  panelPosition,
  shouldLockOnHide,
  vaultPanelStateOf,
} from "./vault-panel.ts";

const menuBar = { x: 0, y: 0, width: 1440, height: 900 };
const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const item = (x: number) => ({ x, y: 0, width: 26, height: 24 });
const panel = { width: PANEL_WIDTH, height: 420 };

describe("where the quick-access panel is drawn", () => {
  it("centres under the menu-bar item, below the bar", () => {
    const { x, y } = panelPosition({ anchor: item(1000), work: workArea, ...panel });
    expect(x).toBe(1000 + 13 - PANEL_WIDTH / 2);
    expect(y).toBe(24 + 6);
  });

  it("stays on the display when the item sits at the right edge", () => {
    const { x } = panelPosition({ anchor: item(1410), work: workArea, ...panel });
    expect(x + PANEL_WIDTH).toBeLessThanOrEqual(workArea.x + workArea.width);
  });

  it("stays on the display when the item sits at the left edge", () => {
    const { x } = panelPosition({ anchor: { ...item(0), x: 2 }, work: workArea, ...panel });
    expect(x).toBeGreaterThanOrEqual(workArea.x);
  });

  it("goes to the top right when the platform reports no item bounds", () => {
    // Linux and some Windows shells answer a zero rectangle. Without this the panel would be drawn at
    // x = 0, y = 0 — under the menu bar on the wrong side of the screen — rather than near its icon.
    const { x, y } = panelPosition({
      anchor: { x: 0, y: 0, width: 0, height: 0 },
      work: workArea,
      ...panel,
    });
    expect(x + PANEL_WIDTH).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(y).toBeGreaterThanOrEqual(workArea.y);
  });

  it("never pushes a tall panel off the bottom of a short display", () => {
    const short = { x: 0, y: 25, width: 1440, height: 300 };
    const { y } = panelPosition({
      anchor: item(700),
      work: short,
      width: PANEL_WIDTH,
      height: 560,
    });
    expect(y).toBeGreaterThanOrEqual(short.y);
    expect(y).toBeLessThanOrEqual(short.y + short.height);
  });

  it("ignores the menu bar's own full-screen rectangle in favour of the work area", () => {
    const { y } = panelPosition({ anchor: item(700), work: workArea, ...panel });
    expect(y).toBeGreaterThan(menuBar.y);
  });
});

describe("the panel's height", () => {
  it("takes the renderer's measurement inside its bounds", () => {
    expect(clampPanelHeight(312.4)).toBe(312);
  });

  it("clamps a measurement that is too small or too large", () => {
    expect(clampPanelHeight(10)).toBe(PANEL_MIN_HEIGHT);
    expect(clampPanelHeight(5000)).toBe(PANEL_MAX_HEIGHT);
  });

  it("refuses anything that is not a finite number", () => {
    expect(clampPanelHeight("420")).toBeNull();
    expect(clampPanelHeight(Number.NaN)).toBeNull();
    expect(clampPanelHeight(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampPanelHeight(null)).toBeNull();
  });
});

describe("what the panel reports about itself", () => {
  it("accepts a well-formed report", () => {
    expect(
      vaultPanelStateOf({ unlocked: true, unlockedHere: true, email: "maya@example.com" }),
    ).toEqual({ unlocked: true, unlockedHere: true, email: "maya@example.com" });
  });

  it("refuses a report with the wrong shape rather than guessing at it", () => {
    expect(vaultPanelStateOf(null)).toBeNull();
    expect(vaultPanelStateOf({ unlocked: "yes", unlockedHere: false, email: null })).toBeNull();
    expect(vaultPanelStateOf({ unlocked: true, email: null })).toBeNull();
    expect(vaultPanelStateOf({ unlocked: true, unlockedHere: true, email: 12 })).toBeNull();
  });

  it("refuses an address long enough to choose the tray menu's width", () => {
    const long = `${"a".repeat(400)}@example.com`;
    expect(vaultPanelStateOf({ unlocked: true, unlockedHere: true, email: long })).toBeNull();
  });

  it("treats a missing address as signed-out rather than as an empty name", () => {
    expect(vaultPanelStateOf({ unlocked: false, unlockedHere: false })?.email).toBeNull();
    expect(vaultPanelStateOf({ unlocked: false, unlockedHere: false, email: "" })).toBeNull();
  });
});

describe("whether closing the panel locks the vault", () => {
  it("locks the vault the panel opened", () => {
    expect(shouldLockOnHide({ unlocked: true, unlockedHere: true, email: null })).toBe(true);
  });

  it("leaves a vault the workspace already had open alone", () => {
    // One vault session serves both windows. A panel that locked unconditionally would relock the
    // vault someone was working in, every time they glanced at the menu bar.
    expect(shouldLockOnHide({ unlocked: true, unlockedHere: false, email: null })).toBe(false);
  });

  it("has nothing to lock when the panel never opened it", () => {
    expect(shouldLockOnHide(initialVaultPanelState)).toBe(false);
  });
});

describe("the paths the panel may open in the workspace", () => {
  it("allows the links the panel actually shows", () => {
    expect(appPathFor("/now")).toBe("/now");
    expect(appPathFor("/vault")).toBe("/vault");
    expect(appPathFor("/signin")).toBe("/signin");
  });

  it("allows one vault item, named by a canonical id", () => {
    const id = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001";
    expect(appPathFor(`/vault/items/${id}`)).toBe(`/vault/items/${id}`);
  });

  it("refuses anything else, because the renderer chooses the value", () => {
    expect(appPathFor("/settings")).toBeNull();
    expect(appPathFor("/vault/items/not-an-id")).toBeNull();
    // A non-canonical id: uppercase, and no version nibble. The api would refuse it too.
    expect(appPathFor("/vault/items/01929F3E-7C1A-4B2E-9A55-3C2F1D0E0001")).toBeNull();
    expect(appPathFor("https://example.test/now")).toBeNull();
    expect(appPathFor("/vault/items/../../oauth/authorize")).toBeNull();
    expect(appPathFor(42)).toBeNull();
  });
});
