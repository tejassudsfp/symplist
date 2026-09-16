import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSearchFilters } from "./filters.ts";
import {
  captureReturnFocus,
  consumeSearchJump,
  forgetSearchScreen,
  peekSearchJump,
  recallSearchScreen,
  rememberSearchScreen,
  SEARCH_JUMP_TTL_MS,
  searchFreshness,
  searchOverlay,
  setSearchJump,
} from "./store.ts";

afterEach(() => {
  searchOverlay.close();
  searchFreshness.reset();
  forgetSearchScreen();
  document.body.innerHTML = "";
});

describe("the overlay store", () => {
  it("opens the palette with the seeded mode and query and closes again", () => {
    expect(searchOverlay.get()).toEqual({ kind: "closed" });
    searchOverlay.openPalette({ mode: "actions", query: "move" });
    const overlay = searchOverlay.get();
    expect(overlay).toMatchObject({ kind: "palette", mode: "actions", query: "move" });
    searchOverlay.close();
    expect(searchOverlay.get()).toEqual({ kind: "closed" });
  });

  it("remembers where focus came from and which pane held it", () => {
    document.body.innerHTML = `<div data-pane="inbox"><button id="row" type="button">Row</button></div>`;
    document.getElementById("row")?.focus();
    searchOverlay.openPalette();
    expect(searchOverlay.get()).toMatchObject({
      kind: "palette",
      pane: "inbox",
      returnFocus: document.getElementById("row"),
    });
  });

  it("returns focus to the menu trigger when the menu item opened the overlay", () => {
    document.body.innerHTML = `
      <button id="trigger" type="button" aria-haspopup="menu" aria-expanded="true">Account</button>
      <div role="menu"><button id="item" type="button">Keyboard shortcuts</button></div>`;
    document.getElementById("item")?.focus();
    searchOverlay.openHelp();
    expect(searchOverlay.get()).toMatchObject({
      kind: "help",
      returnFocus: document.getElementById("trigger"),
    });
  });

  it("captures nothing when focus is on the page body", () => {
    document.body.innerHTML = "<p>Nothing focusable</p>";
    expect(captureReturnFocus(document)).toEqual({ element: null, pane: null });
  });

  it("notifies subscribers and gives every opening its own count", () => {
    const listener = vi.fn();
    const unsubscribe = searchOverlay.subscribe(listener);
    searchOverlay.openPalette();
    const first = searchOverlay.get();
    searchOverlay.close();
    searchOverlay.openPalette();
    const second = searchOverlay.get();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(first.kind === "palette" && second.kind === "palette").toBe(true);
    expect(first.kind === "palette" ? first.openCount : 0).toBeLessThan(
      second.kind === "palette" ? second.openCount : 0,
    );
    unsubscribe();
  });
});

describe("freshness signals", () => {
  it("accepts a valid search.freshness event and refuses anything else", () => {
    expect(searchFreshness.publish({ generation: 7, pending: 2 }, 1000)).toBe(true);
    expect(searchFreshness.get()).toEqual({ generation: 7, pending: 2, receivedAt: 1000 });
    expect(searchFreshness.publish({ generation: "7", pending: 0 })).toBe(false);
    expect(searchFreshness.publish({ generation: 8, pending: 0, extra: true })).toBe(false);
    expect(searchFreshness.get()?.generation).toBe(7);
  });

  it("never lets an older announcement hide a newer generation", () => {
    searchFreshness.publish({ generation: 9, pending: 0 }, 10);
    expect(searchFreshness.publish({ generation: 8, pending: 4 }, 20)).toBe(false);
    expect(searchFreshness.get()?.generation).toBe(9);
    expect(searchFreshness.publish({ generation: 10, pending: 1 }, 30)).toBe(true);
    expect(searchFreshness.get()).toEqual({ generation: 10, pending: 1, receivedAt: 30 });
  });
});

describe("screen memory and jumps", () => {
  it("keeps the query and filters in memory only", () => {
    expect(recallSearchScreen()).toBeNull();
    rememberSearchScreen({
      query: "portfolio",
      filters: defaultSearchFilters,
      returnHref: "/now",
      activeKey: null,
    });
    expect(recallSearchScreen()?.query).toBe("portfolio");
    // Nothing is written to browser storage (note 14: no raw query history by default).
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    forgetSearchScreen();
    expect(recallSearchScreen()).toBeNull();
  });

  it("hands a jump to the task that was opened, once, and expires it", () => {
    setSearchJump({ taskId: "t1", query: "portfolio" }, 1000);
    expect(peekSearchJump("t2", 1000)).toBeNull();
    expect(peekSearchJump("t1", 1000)?.query).toBe("portfolio");
    expect(consumeSearchJump("t1", 1000)?.taskId).toBe("t1");
    expect(consumeSearchJump("t1", 1000)).toBeNull();

    setSearchJump({ taskId: "t3", query: "q" }, 1000);
    expect(peekSearchJump("t3", 1000 + SEARCH_JUMP_TTL_MS + 1)).toBeNull();
  });
});
