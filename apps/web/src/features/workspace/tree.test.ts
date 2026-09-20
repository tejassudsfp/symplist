import type { TaskCollection, TaskId, TaskNode } from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  childrenOf,
  dropPlacement,
  insertSubtree,
  isSelfOrDescendant,
  normalizeForSearch,
  promoteChildren,
  removeSubtree,
  renameInList,
  subtreeOf,
  type TaskList,
  undoMoveRequest,
  visibleRows,
} from "./tree.ts";

let sequence = 0;

function node(
  id: string,
  depth: number,
  parentId: string | null,
  options: { childCount?: number; collection?: TaskCollection; title?: string } = {},
): TaskNode {
  sequence += 1;
  return {
    id: id as TaskId,
    parentId: parentId as TaskId | null,
    collection: options.collection ?? "now",
    position: `a${sequence}`,
    depth,
    title: options.title ?? id,
    preview: null,
    source: "user",
    version: 1,
    childCount: options.childCount ?? 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Refresh my portfolio (two subtasks) · Send the project outline · Book a bike tune-up. */
function sampleList(): TaskList {
  return [
    node("portfolio", 0, null, { childCount: 2, title: "Refresh my portfolio" }),
    node("pick", 1, "portfolio", { title: "Pick five projects to feature" }),
    node("about", 1, "portfolio", { title: "Rewrite the about page" }),
    node("outline", 0, null, { title: "Send the project outline" }),
    node("bike", 0, null, { title: "Book a bike tune-up" }),
  ];
}

const ids = (list: TaskList) => list.map((task) => task.id);

describe("task tree helpers", () => {
  it("reads subtrees, children and ancestors in pre-order", () => {
    const list = sampleList();
    expect(ids(subtreeOf(list, "portfolio"))).toEqual(["portfolio", "pick", "about"]);
    expect(ids(childrenOf(list, "portfolio"))).toEqual(["pick", "about"]);
    expect(ids(childrenOf(list, null))).toEqual(["portfolio", "outline", "bike"]);
    expect(ids(ancestorsOf(list, "pick"))).toEqual(["portfolio"]);
    expect(isSelfOrDescendant(list, "portfolio", "about")).toBe(true);
    expect(isSelfOrDescendant(list, "outline", "about")).toBe(false);
  });

  it("removes a subtree with its parent's count and puts it back somewhere else", () => {
    const list = sampleList();
    const { list: without, removed } = removeSubtree(list, "pick");
    expect(ids(without)).toEqual(["portfolio", "about", "outline", "bike"]);
    expect(without[0]?.childCount).toBe(1);

    const moved = insertSubtree(without, removed, { collection: "later", parentId: null });
    const pick = moved.find((task) => task.id === "pick");
    expect(pick?.depth).toBe(0);
    expect(pick?.parentId).toBeNull();
    expect(pick?.collection).toBe("later");
    expect(ids(moved).at(-1)).toBe("pick");
  });

  it("inserts after a named sibling, keeping the sibling's own subtask below it", () => {
    const list = sampleList();
    const { list: without, removed } = removeSubtree(list, "bike");
    const moved = insertSubtree(without, removed, {
      collection: "now",
      parentId: null,
      afterId: "portfolio",
    });
    expect(ids(moved)).toEqual(["portfolio", "pick", "about", "bike", "outline"]);
  });

  it("promotes the subtasks of a parent completed on its own (decision WS6)", () => {
    const list = sampleList();
    const promoted = promoteChildren(list, "portfolio");
    expect(ids(promoted)).toEqual(["pick", "about", "outline", "bike"]);
    expect(promoted[0]?.depth).toBe(0);
    expect(promoted[0]?.parentId).toBeNull();
  });

  it("shows only the rows whose parents are expanded, and every match while searching", () => {
    const list = sampleList();
    expect(visibleRows(list, new Set()).map((row) => row.task.id)).toEqual([
      "portfolio",
      "outline",
      "bike",
    ]);
    const open = visibleRows(list, new Set(["portfolio"]));
    expect(open.map((row) => row.task.id)).toEqual([
      "portfolio",
      "pick",
      "about",
      "outline",
      "bike",
    ]);
    expect(open[0]?.expanded).toBe(true);

    const found = visibleRows(list, new Set(), "PROJECT");
    // "Pick five projects to feature" matches; its parent comes with it as context, so the tree
    // never jumps from level 1 to level 3 with no level-2 row in between.
    expect(found.map((row) => [row.task.id, row.matched])).toEqual([
      ["portfolio", false],
      ["pick", true],
      ["outline", true],
    ]);
    expect(found[0]?.expanded).toBe(true);
    expect(visibleRows(list, new Set(), "kayak")).toEqual([]);
    expect(normalizeForSearch("Réunion")).toBe("reunion");
  });

  it("numbers each row within its own level, never within the flat list", () => {
    const list = sampleList();
    const open = visibleRows(list, new Set(["portfolio"]));
    const positions = open.map(
      (row) => `${row.task.id} ${row.task.depth + 1}: ${row.posInSet}/${row.setSize}`,
    );
    expect(positions).toEqual([
      "portfolio 1: 1/3",
      "pick 2: 1/2",
      "about 2: 2/2",
      "outline 1: 2/3",
      "bike 1: 3/3",
    ]);

    // A collapsed sublist takes its rows out of the set sizes, because they are not shown.
    expect(visibleRows(list, new Set()).map((row) => `${row.posInSet}/${row.setSize}`)).toEqual([
      "1/3",
      "2/3",
      "3/3",
    ]);

    // While searching, the set is the rows shown at that level, not the whole level.
    expect(
      visibleRows(list, new Set(), "project").map(
        (row) => `${row.task.id} ${row.posInSet}/${row.setSize}`,
      ),
    ).toEqual(["portfolio 1/2", "pick 1/1", "outline 2/2"]);
  });

  it("renames in place without touching anything else", () => {
    const renamed = renameInList(sampleList(), "bike", "Book the bike service");
    expect(renamed.find((task) => task.id === "bike")?.title).toBe("Book the bike service");
    expect(ids(renamed)).toEqual(ids(sampleList()));
  });

  it("turns a drop into the move request the server decides from", () => {
    const list = sampleList();
    const after = dropPlacement(list, "bike", "portfolio", "after");
    expect(after?.request).toEqual({ afterId: "portfolio" });
    expect(after?.insert).toEqual({ collection: "now", parentId: null, afterId: "portfolio" });

    const nested = dropPlacement(list, "bike", "pick", "before");
    expect(nested?.insert.parentId).toBe("portfolio");

    // A drop that changes nothing, or into the task's own subtree, is not a move.
    expect(dropPlacement(list, "portfolio", "pick", "after")).toBeNull();
    expect(dropPlacement(list, "outline", "portfolio", "after")).toBeNull();
    expect(dropPlacement(list, "bike", "bike", "before")).toBeNull();
  });

  it("builds the Undo move from the placement the server reported", () => {
    const list = sampleList();
    const undo = undoMoveRequest(list, "bike", {
      collection: "later",
      parentId: null,
      afterId: null,
    });
    // First among its siblings: name the task it now sits before.
    expect(undo.request).toEqual({ collection: "later", parentId: null });
    expect(undo.insert.collection).toBe("later");

    const undoAfter = undoMoveRequest(list, "bike", {
      collection: "now",
      parentId: null,
      afterId: "portfolio" as TaskId,
    });
    expect(undoAfter.request).toEqual({
      collection: "now",
      parentId: null,
      afterId: "portfolio",
    });
  });
});
