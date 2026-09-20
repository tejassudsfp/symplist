import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { featureIds } from "@symplist/contracts";
import { describe, expect, it } from "vitest";
import { featureModules } from "./app.module.ts";
import { SystemModule } from "./modules/system/system.module.ts";

const pascal = (id: string) => `${id[0]?.toUpperCase()}${id.slice(1)}Module`;

describe("feature module seams (§2.3)", () => {
  it("imports one module per contracts feature id, from that feature's own folder", async () => {
    const expected: unknown[] = [SystemModule];
    for (const id of featureIds) {
      const file = fileURLToPath(new URL(`./modules/${id}/${id}.module.ts`, import.meta.url));
      expect(existsSync(file), `modules/${id}/${id}.module.ts exists`).toBe(true);
      const module = (await import(file)) as Record<string, unknown>;
      const feature = module[pascal(id)];
      expect(feature, `${pascal(id)} is exported`).toBeTypeOf("function");
      expect(featureModules, `${pascal(id)} is imported by the app`).toContain(feature);
      expected.push(feature);
    }
    expect([...featureModules]).toHaveLength(expected.length);
    expect(new Set(featureModules).size).toBe(featureModules.length);
    expect(new Set(featureModules)).toEqual(new Set(expected));
  });

  it("keeps feature modules free of cross-feature imports and exports", () => {
    for (const feature of featureModules) {
      for (const key of [MODULE_METADATA.IMPORTS, MODULE_METADATA.EXPORTS]) {
        const listed = (Reflect.getMetadata(key, feature) ?? []) as unknown[];
        const otherFeatures = listed.filter((entry) =>
          (featureModules as readonly unknown[]).includes(entry),
        );
        expect(otherFeatures, `${feature.name} ${key}`).toEqual([]);
      }
    }
  });
});
