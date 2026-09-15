import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sessionRevokeContributors } from "./index.ts";

describe("session revoke contributors (§5.1, §2.3)", () => {
  it("registers every contributor file exactly once", () => {
    const files = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => !["index.ts", "types.ts"].includes(file))
      .map((file) => file.replace(/\.ts$/, ""))
      .sort();
    const domains = sessionRevokeContributors.map((contributor) => contributor.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect([...domains].sort()).toEqual(files);
  });
});
