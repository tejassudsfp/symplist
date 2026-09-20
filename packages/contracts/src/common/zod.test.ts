import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { schemaCompilationDisabled, z } from "./zod.ts";

/*
 * Schema compilation and the browser's CSP (§5.3, decision W1). The api and the worker run in Node,
 * where nothing forbids compiling a schema, so this suite pins both halves of the decision: the
 * default stays compiled, and asking for the interpreted path keeps every schema parsing the same.
 */

describe("schema compilation", () => {
  it("is settled before the package builds a single schema", () => {
    // A schema module that takes zod straight from the package settles compilation by constructing
    // its first schema, before anything has had the chance to choose — and a bundler concatenates
    // modules in import order, so no amount of ordering in the barrel can fix that after the fact.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const directZodImport = /\bfrom\s+["']zod["']/;
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith(".ts")) {
          if (path.endsWith(join("common", "zod.ts"))) continue;
          if (directZodImport.test(readFileSync(path, "utf8")))
            offenders.push(path.slice(root.length));
        }
      }
    };
    walk(root);
    expect(offenders, "these modules must import z from common/zod.ts").toEqual([]);
  });

  it("is left enabled outside the browser", () => {
    // There is no `window` here, so the module must not have changed anything.
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    expect(schemaCompilationDisabled()).toBe(false);
    expect(z.config().jitless).not.toBe(true);
  });

  it("parses identically with compilation disabled, which is what the browser uses", () => {
    const schema = z.strictObject({
      id: z.uuid(),
      title: z.string().min(1).max(10),
      count: z.number().int().nonnegative(),
      nested: z.array(z.union([z.literal("a"), z.literal("b")])).max(2),
    });
    const valid = {
      id: "0192a000-0000-7000-8000-00000000000a",
      title: "Hello",
      count: 2,
      nested: ["a", "b"],
    };
    const invalid = { id: "not-a-uuid", title: "", count: -1, nested: ["c"], extra: true };

    const compiled = {
      ok: schema.safeParse(valid),
      bad: schema.safeParse(invalid),
    };
    z.config({ jitless: true });
    try {
      const interpreted = {
        ok: schema.safeParse(valid),
        bad: schema.safeParse(invalid),
      };
      expect(interpreted.ok).toEqual(compiled.ok);
      expect(interpreted.bad.success).toBe(false);
      expect(interpreted.bad.error?.issues.map((issue) => issue.path.join("."))).toEqual(
        compiled.bad.error?.issues.map((issue) => issue.path.join(".")),
      );
    } finally {
      z.config({ jitless: false });
    }
  });
});
