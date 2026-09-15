import { featureIds } from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveBindings,
  findConflicts,
  isReservedBinding,
} from "./bindings";
import { tryParseBinding } from "./keys";
import { actionRegistry, actionsByFeature } from "./registry-index";
import { shellActions } from "./shell-actions";

describe("action registry", () => {
  it("collects the actions file of every feature", () => {
    expect(Object.keys(actionsByFeature).sort()).toEqual([...featureIds].sort());
  });

  it("never registers two actions with the same id", () => {
    const ids = actionRegistry.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the shell's navigation and panel actions", () => {
    for (const action of shellActions) expect(actionRegistry).toContain(action);
  });

  it("uses only valid default bindings with no conflicts in overlapping contexts", () => {
    for (const action of actionRegistry) {
      if (action.defaultBinding === undefined) continue;
      expect(tryParseBinding(action.defaultBinding), action.id).not.toBeNull();
      expect(tryParseBinding(action.defaultBinding)?.canonical, action.id).toBe(
        action.defaultBinding,
      );
    }
    const bindings = effectiveBindings(actionRegistry, DEFAULT_KEYBOARD_PREFERENCES);
    expect(findConflicts(actionRegistry, bindings)).toEqual([]);
  });

  it("never assigns a reserved browser or OS shortcut by default", () => {
    for (const platform of ["mac", "other"] as const) {
      for (const action of shellActions) {
        if (action.defaultBinding)
          expect(isReservedBinding(action.defaultBinding, platform)).toBe(false);
      }
    }
  });
});
