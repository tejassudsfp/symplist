import { describe, expect, it } from "vitest";
import { generatedSecretFamilies } from "./index.ts";

describe("config", () => {
  it("lists each generated secret family from the inventory once", () => {
    expect(new Set(generatedSecretFamilies).size).toBe(generatedSecretFamilies.length);
    expect(generatedSecretFamilies).toContain("CONTENT_KEK");
  });
});
