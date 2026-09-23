import { describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  MAX_SLASH_QUERY,
  moveSlashSelection,
  slashCommands,
} from "./slash-commands.ts";

const ids = (query: string) => filterSlashCommands(query).map((command) => command.id);

describe("filterSlashCommands", () => {
  it("offers the whole catalog for a bare slash", () => {
    expect(filterSlashCommands("")).toHaveLength(slashCommands.length);
  });

  it("ranks a prefix of the visible name first", () => {
    expect(ids("head")[0]).toBe("heading_1");
    expect(ids("quo")[0]).toBe("quote");
  });

  it("finds a command by the word people actually reach for", () => {
    expect(ids("todo")).toContain("checklist");
    expect(ids("ul")).toContain("bullet_list");
    expect(ids("hr")).toContain("divider");
  });

  it("matches a later word of a multi-word name", () => {
    expect(ids("list")).toContain("bullet_list");
    expect(ids("list")).toContain("ordered_list");
  });

  it("ignores case and surrounding space", () => {
    expect(ids("  TABLE ")).toEqual(ids("table"));
  });

  it("keeps catalog order within one rank, so the list does not reshuffle as you type", () => {
    const listed = ids("list");
    expect(listed.indexOf("bullet_list")).toBeLessThan(listed.indexOf("ordered_list"));
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(ids("zzzz")).toEqual([]);
  });

  it("gives up rather than matching an essay", () => {
    expect(filterSlashCommands("h".repeat(MAX_SLASH_QUERY + 1))).toEqual([]);
  });

  it("keeps Simon out of the editor's own command set", () => {
    const simon = slashCommands.find((command) => command.id === "ask_simon");
    expect(simon?.external).toBe(true);
    for (const command of slashCommands) {
      if (command.id !== "ask_simon") expect(command.external).toBeUndefined();
    }
  });

  it("gives every command a distinct id and a hint", () => {
    expect(new Set(slashCommands.map((command) => command.id)).size).toBe(slashCommands.length);
    for (const command of slashCommands) {
      expect(command.hint.length).toBeGreaterThan(0);
      expect(command.label.length).toBeGreaterThan(0);
    }
  });
});

describe("moveSlashSelection", () => {
  it("wraps at both ends", () => {
    expect(moveSlashSelection(2, 1, 3)).toBe(0);
    expect(moveSlashSelection(0, -1, 3)).toBe(2);
  });

  it("stays at zero for an empty list rather than going negative", () => {
    expect(moveSlashSelection(0, -1, 0)).toBe(0);
    expect(moveSlashSelection(4, 1, 0)).toBe(0);
  });
});
