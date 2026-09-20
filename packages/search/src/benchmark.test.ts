import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountKey, createKeyProvider, keyFamilies } from "@symplist/crypto";
import { describe, expect, it, vi } from "vitest";
import { openSearchIndex, sealSearchIndex } from "./envelope.ts";
import { extraTask, ownerId, request } from "./fixtures.test-support.ts";
import { textRules } from "./match.ts";
import { parseQuery } from "./query.ts";
import { runSearch } from "./rank.ts";
import { SearchIndex } from "./search-index.ts";
import { buildSnippet } from "./snippet.ts";
import { SearchView } from "./view.ts";

const vocabulary = [
  "budget",
  "garden",
  "outline",
  "portfolio",
  "pottery",
  "weekend",
  "invoice",
  "travel",
  "kingfisher",
  "東京",
  "予定",
  "मिठाई",
  "योजना",
  "İstanbul",
  "Straße",
  "café",
  "Ωμέγα",
  "résumé",
  "ﬁle",
  "ＦＵＬＬ",
  "photo",
  "camera",
  "notes",
  "draft",
  "review",
  "project",
];

/** A deterministic pseudo-random generator, so every run indexes the same corpus. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function sentence(next: () => number, words: number): string {
  return Array.from({ length: words }, () => {
    const roll = next();
    return roll < 0.35
      ? (vocabulary[Math.floor(next() * vocabulary.length)] as string)
      : `w${Math.floor(next() * 20_000)}`;
  }).join(" ");
}

describe("search benchmark (note 14 performance targets)", () => {
  it("builds, seals, opens and queries a beta-sized corpus within generous bounds", async () => {
    const next = generator(42);
    const tasks = 500;
    const sectionsPerTask = 4;
    const index = SearchIndex.create({ ownerId, includeChat: false });
    const started = performance.now();
    for (let t = 0; t < tasks; t += 1) {
      const task = extraTask(t + 1, sentence(next, 5));
      index.upsertTask(task);
      index.replaceDocument({
        taskId: task.id,
        revision: `rev${t}`,
        sections: Array.from({ length: sectionsPerTask }, (_, ordinal) => ({
          sectionId: `rev${t}.s${ordinal}`,
          ordinal,
          heading: sentence(next, 3),
          text: sentence(next, 180),
        })),
      });
    }
    const buildMs = performance.now() - started;

    const provider = createKeyProvider(
      Object.fromEntries(
        keyFamilies.map((family) => [
          family,
          { current: 1, versions: new Map([[1, randomBytes(32)]]) },
        ]),
      ),
    );
    const { key } = createAccountKey(provider, ownerId);
    const writeId = "0192f0a0-2222-7000-8000-000000000001";
    const sealStarted = performance.now();
    const sealed = await sealSearchIndex(key, index, { generation: 1, appliedThrough: 0, writeId });
    const sealMs = performance.now() - sealStarted;
    const openStarted = performance.now();
    const opened = openSearchIndex(key, sealed.body, { ownerId, generation: 1, writeId });
    const openMs = performance.now() - openStarted;

    const view = SearchView.of(opened.index);
    const queries = [
      "budget garden",
      "東京",
      "istanbul",
      "portf",
      '"camera notes"',
      "kingfisher",
      "w123",
      "cafe resume",
    ];
    const queryStarted = performance.now();
    let groups = 0;
    for (let round = 0; round < 5; round += 1) {
      for (const text of queries) {
        const query = parseQuery(text);
        const run = runSearch(view, query, request());
        groups += run.groups.length;
        for (const group of run.groups.slice(0, 20)) {
          for (const hit of group.sections.slice(0, 3)) {
            buildSnippet(hit.entry.text, query, { rules: textRules });
          }
        }
      }
    }
    const averageQueryMs = (performance.now() - queryStarted) / (queries.length * 5);

    const report = {
      corpus: { tasks, sections: tasks * sectionsPerTask, textChars: index.stats().textChars },
      plaintextBytes: sealed.plaintextBytes,
      buildMs: Math.round(buildMs),
      sealMs: Math.round(sealMs),
      openMs: Math.round(openMs),
      averageQueryMs: Number(averageQueryMs.toFixed(2)),
      hardware: `${platform()} ${arch()} ${cpus()[0]?.model ?? "cpu"} x${cpus().length}`,
      node: process.version,
    };
    // Recorded in the test output with the corpus size and hardware, as note 14 asks.
    console.info("search benchmark", JSON.stringify(report));
    expect(groups).toBeGreaterThan(0);
    expect(opened.index.stats()).toEqual(index.stats());
    // Bounds are an order of magnitude above measured values, so slow CI hosts do not flake while a
    // regression of the approach (for example re-tokenizing the corpus per query) still fails.
    expect(averageQueryMs).toBeLessThan(150);
    expect(openMs).toBeLessThan(5_000);
    expect(sealed.plaintextBytes).toBeLessThan(64 * 1024 * 1024);
  }, 60_000);
});

describe("no model or network use (note 14)", () => {
  const srcDir = fileURLToPath(new URL(".", import.meta.url));

  it("imports only contracts, crypto, MiniSearch and Node built-ins", () => {
    const allowed = /^(?:\.\.?\/|node:|@symplist\/(?:contracts|crypto)$|minisearch$)/;
    const testOnly = /^(?:vitest$|@symplist\/testing$)/;
    const offending: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(srcDir, name), "utf8");
      const isTest = /\.test(?:-support)?\.ts$/.test(name);
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] as string;
        if (allowed.test(specifier) || (isTest && testOnly.test(specifier))) continue;
        offending.push(`${name}: ${specifier}`);
      }
      if (!isTest && /\bfetch\s*\(/.test(source)) offending.push(`${name}: fetch`);
    }
    expect(offending).toEqual([]);
  });

  it("indexes, seals and queries with the network unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("search must not use the network");
    });
    const index = SearchIndex.create({ ownerId, includeChat: false });
    index.upsertTask(extraTask(1, "Offline task"));
    const provider = createKeyProvider(
      Object.fromEntries(
        keyFamilies.map((family) => [
          family,
          { current: 1, versions: new Map([[1, randomBytes(32)]]) },
        ]),
      ),
    );
    const { key } = createAccountKey(provider, ownerId);
    const writeId = "0192f0a0-2222-7000-8000-000000000002";
    const sealed = await sealSearchIndex(key, index, { generation: 1, appliedThrough: 0, writeId });
    const opened = openSearchIndex(key, sealed.body, { ownerId, generation: 1, writeId });
    expect(
      runSearch(SearchView.of(opened.index), parseQuery("offline"), request()).groups,
    ).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
