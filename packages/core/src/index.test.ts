import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restrictContributors } from "./access/index.ts";
import { purgeContributors } from "./account/index.ts";
import { coreDomains } from "./domains.ts";
import { archiveContributors } from "./tasks/index.ts";

const contributorFiles = (folder: string) =>
  readdirSync(fileURLToPath(new URL(folder, import.meta.url)))
    .filter((file) => file.endsWith(".ts") && !["index.ts", "types.ts"].includes(file))
    .map((file) => file.replace(/\.ts$/, ""))
    .sort();

describe("core seams", () => {
  it("has a folder for every core domain", () => {
    const folders = readdirSync(fileURLToPath(new URL(".", import.meta.url)), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual([...coreDomains].sort());
  });

  it.each([
    ["./access/restrict-contributors/", restrictContributors],
    ["./account/purge-contributors/", purgeContributors],
    ["./tasks/archive-contributors/", archiveContributors],
  ] as const)("registers every contributor file in %s exactly once", (folder, registry) => {
    const domains = registry.map((contributor) => contributor.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect([...domains].sort()).toEqual(contributorFiles(folder));
  });
});
