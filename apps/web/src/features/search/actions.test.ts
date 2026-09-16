import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveBindings,
  findConflicts,
  isReservedBinding,
} from "@/actions/bindings";
import { actionRegistry } from "@/actions/registry-index";
import { SHORTCUT_HELP_ACTION_ID } from "@/actions/shell-actions";
import type { ActionEnvironment, ActionServices, AppAction } from "@/actions/types";
import {
  FULL_SEARCH_ACTION_ID,
  OPEN_PALETTE_ACTION_ID,
  SURFACE_FIND_ACTION_ID,
  searchActions,
} from "./actions.ts";
import { SEARCH_PATH } from "./routes.ts";
import { searchOverlay } from "./store.ts";
import { SURFACE_FIND_ATTRIBUTE } from "./surface-find.ts";

function environment(overrides: Partial<ActionEnvironment> = {}) {
  const services: ActionServices = {
    navigate: vi.fn(),
    assign: vi.fn(),
    announce: vi.fn(),
    route: null,
    shell: null,
    ...(overrides.services ?? {}),
  };
  const env: ActionEnvironment = {
    source: "keyboard",
    platform: "other",
    pane: null,
    ...overrides,
    services,
  };
  return { env, services };
}

const byId = (id: string): AppAction => {
  const action = searchActions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(id);
  return action;
};

afterEach(() => {
  searchOverlay.close();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("search actions", () => {
  it("registers the note 13 bindings for the palette, surface find and the shortcut reference", () => {
    expect(byId(OPEN_PALETTE_ACTION_ID).defaultBinding).toBe("mod+k");
    expect(byId(SURFACE_FIND_ACTION_ID).defaultBinding).toBe("/");
    expect(byId(SHORTCUT_HELP_ACTION_ID).defaultBinding).toBe("?");
    // Full search is exposed in the palette with no risky default chord (note 13).
    expect(byId(FULL_SEARCH_ACTION_ID).defaultBinding).toBeUndefined();
    for (const action of searchActions) expect(action.context).toBe("app");
  });

  it("never collides with another feature's binding and keeps browser keys free", () => {
    const bindings = effectiveBindings(actionRegistry, DEFAULT_KEYBOARD_PREFERENCES);
    const conflicts = findConflicts(actionRegistry, bindings).filter((conflict) =>
      conflict.actionIds.some((id) => id.startsWith("search.")),
    );
    expect(conflicts).toEqual([]);
    for (const platform of ["mac", "other"] as const) {
      for (const action of searchActions) {
        if (!action.defaultBinding) continue;
        // Mod+K is a Symplist default the palette owns; every other binding must be free.
        if (action.id === OPEN_PALETTE_ACTION_ID) continue;
        expect(isReservedBinding(action.defaultBinding, platform), action.id).toBe(false);
      }
    }
    for (const action of searchActions) expect(actionRegistry).toContain(action);
  });

  it("opens the palette and the shortcut help through the shared overlay", () => {
    const { env } = environment();
    void byId(OPEN_PALETTE_ACTION_ID).run(env);
    expect(searchOverlay.get()).toMatchObject({ kind: "palette", mode: "tasks", query: "" });
    searchOverlay.close();
    void byId(SHORTCUT_HELP_ACTION_ID).run(env);
    expect(searchOverlay.get()).toMatchObject({ kind: "help" });
  });

  it("navigates to full search without putting the query in the address", () => {
    const { env, services } = environment();
    void byId(FULL_SEARCH_ACTION_ID).run(env);
    expect(services.navigate).toHaveBeenCalledWith(SEARCH_PATH);
    expect(SEARCH_PATH).toBe("/search");
  });

  it("focuses the find field of the focused pane and explains when a view has none", () => {
    const find = byId(SURFACE_FIND_ACTION_ID);
    const { env } = environment({ pane: "inbox" });
    expect(find.availability(env)).toEqual({
      enabled: false,
      reason: "This view has nothing to search",
    });

    document.body.innerHTML = `
      <div data-pane="chat"><input id="chat-find" ${SURFACE_FIND_ATTRIBUTE}="chat" /></div>
      <div data-pane="inbox"><input id="inbox-find" ${SURFACE_FIND_ATTRIBUTE}="inbox" /></div>`;
    for (const element of document.querySelectorAll("input")) {
      element.checkVisibility = () => true;
    }
    expect(find.availability(env)).toEqual({ enabled: true });
    void find.run(env);
    expect(document.activeElement?.id).toBe("inbox-find");

    // Outside a pane (the full search screen) the visible field is focused.
    const outside = environment({ pane: null });
    void find.run(outside.env);
    expect(document.activeElement?.id).toBe("chat-find");
  });
});
