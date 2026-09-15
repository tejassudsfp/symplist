import { describe, expect, it } from "vitest";
import { collectionMeta, collections, isExcludedRoute, parseWorkspaceRoute } from "./routes.ts";
import {
  CHAT_SIZE,
  INBOX_SIZE,
  initialShellState,
  isChatVisible,
  isInboxVisible,
  shellReducer,
} from "./shell-state.ts";

describe("workspace routes", () => {
  it.each([
    ["/now", { collection: "now", taskId: null }],
    ["/later/", { collection: "later", taskId: null }],
    [
      "/unclassified/01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a",
      { collection: "unclassified", taskId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a" },
    ],
  ])("parses %s", (path, route) => {
    expect(parseWorkspaceRoute(path)).toEqual(route);
  });

  it.each([
    null,
    undefined,
    "",
    "/",
    "/archive",
    "/settings/account",
    "/now/a/b",
    "/now/<script>",
    "/vault",
  ])("treats %j as outside the workspace", (path) => {
    expect(parseWorkspaceRoute(path)).toBeNull();
  });

  it("lists Now, Later and Unclassified with their note 13 shortcuts", () => {
    expect(collections.map((collection) => [collection.label, collection.shortcut])).toEqual([
      ["Now", "g n"],
      ["Later", "g l"],
      ["Unclassified", "g u"],
    ]);
    expect(collectionMeta("later").href).toBe("/later");
  });

  it("identifies the excluded route groups that need a full navigation", () => {
    for (const href of [
      "/signin",
      "/signin/verify",
      "/access/paused",
      "/vault",
      "/vault/items/1?x=1",
      "/oauth/consent#r",
    ]) {
      expect(isExcludedRoute(href)).toBe(true);
    }
    for (const href of ["/now", "/settings/account", "/vaulted", "/signing", "/archive"]) {
      expect(isExcludedRoute(href)).toBe(false);
    }
  });
});

describe("shell state", () => {
  const now = { collection: "now", taskId: null } as const;
  const task = { collection: "now", taskId: "t1" } as const;

  it("uses the sample's panel limits", () => {
    expect(INBOX_SIZE).toEqual({ min: 240, default: 280, max: 400 });
    expect(CHAT_SIZE).toEqual({ min: 300, default: 340, max: 480 });
  });

  it("opens the laptop drawer on a collection and keeps it closed on a task", () => {
    expect(initialShellState(now).drawerOpen).toBe(true);
    expect(initialShellState(task).drawerOpen).toBe(false);
  });

  it("closes the drawer when a task is selected and resets the phone view to the page", () => {
    let state = initialShellState(now);
    state = shellReducer(state, { type: "route", route: task });
    expect(state.drawerOpen).toBe(false);
    state = shellReducer(state, { type: "show", view: "chat" });
    expect(state.mobileView).toBe("chat");
    state = shellReducer(state, { type: "route", route: { collection: "now", taskId: "t2" } });
    expect(state.mobileView).toBe("page");
    state = shellReducer(state, { type: "route", route: { collection: "later", taskId: null } });
    expect(state.drawerOpen).toBe(true);
  });

  it("keeps collapse choices across navigation and returns the same object for no-ops", () => {
    let state = initialShellState(task);
    state = shellReducer(state, { type: "set-chat-collapsed", collapsed: true });
    state = shellReducer(state, { type: "set-inbox-collapsed", collapsed: true });
    state = shellReducer(state, { type: "route", route: { collection: "later", taskId: "t9" } });
    expect(state.chatCollapsed).toBe(true);
    expect(state.inboxCollapsed).toBe(true);
    expect(shellReducer(state, { type: "set-chat-collapsed", collapsed: true })).toBe(state);
    expect(shellReducer(state, { type: "route", route: state.route })).toBe(state);
    expect(shellReducer(state, { type: "set-drawer", open: state.drawerOpen })).toBe(state);
  });

  it("derives panel visibility per layout mode", () => {
    const base = initialShellState(task);
    expect(isInboxVisible(base, "desktop")).toBe(true);
    expect(isInboxVisible(base, "laptop")).toBe(false);
    expect(isInboxVisible(base, "mobile")).toBe(false);
    expect(isInboxVisible(initialShellState(now), "mobile")).toBe(true);
    expect(isChatVisible(base, "desktop")).toBe(true);
    expect(isChatVisible(base, "mobile")).toBe(false);
    expect(isChatVisible(shellReducer(base, { type: "show", view: "chat" }), "mobile")).toBe(true);
    expect(
      isChatVisible(shellReducer(base, { type: "set-chat-collapsed", collapsed: true }), "laptop"),
    ).toBe(false);
    expect(isChatVisible(initialShellState(now), "desktop")).toBe(false);
  });
});
