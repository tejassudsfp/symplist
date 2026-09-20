import * as configFromPackage from "@symplist/config";
import * as contractsFromPackage from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import * as configFromSource from "../../config/src/index.ts";
import * as contractsFromSource from "../../contracts/src/index.ts";
import { resolveWorkspaceSource } from "./vitest-config.ts";

const normalize = (path: string | undefined) => path?.replaceAll("\\", "/");

describe("workspace resolution (§2.2)", () => {
  it("loads workspace imports from their TypeScript sources, never dist", () => {
    expect(contractsFromPackage.featureIds).toBe(contractsFromSource.featureIds);
    expect(configFromPackage.generatedSecretFamilies).toBe(
      configFromSource.generatedSecretFamilies,
    );
  });

  it("maps package and subpath exports to their source files", () => {
    expect(normalize(resolveWorkspaceSource("@symplist/contracts"))).toMatch(
      /\/packages\/contracts\/src\/index\.ts$/,
    );
    expect(normalize(resolveWorkspaceSource("@symplist/config/web"))).toMatch(
      /\/packages\/config\/src\/web\.ts$/,
    );
    expect(normalize(resolveWorkspaceSource("@symplist/docs/markdown"))).toMatch(
      /\/packages\/docs\/src\/markdown\/index\.ts$/,
    );
    expect(resolveWorkspaceSource("@symplist/contracts/missing")).toBeUndefined();
    expect(resolveWorkspaceSource("eventsource")).toBeUndefined();
  });
});
