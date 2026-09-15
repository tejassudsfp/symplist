import { featureIds } from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import { actionRegistry, actionsByFeature } from "./registry-index";

describe("action registry", () => {
  it("collects the actions file of every feature", () => {
    expect(Object.keys(actionsByFeature).sort()).toEqual([...featureIds].sort());
  });

  it("never registers two actions with the same id", () => {
    const ids = actionRegistry.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
