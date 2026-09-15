import { describe, expect, it } from "vitest";
import { expectCryptoError } from "../test/support.ts";
import { canonicalJson, MAX_CANONICAL_JSON_DEPTH } from "./canonical-json.ts";
import { InvalidCryptoInputError } from "./errors.ts";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,1,2]},"b":1}',
    );
  });

  it("is independent of insertion order", () => {
    expect(canonicalJson({ title: "t", collection: "now" })).toBe(
      canonicalJson({ collection: "now", title: "t" }),
    );
  });

  it("sorts keys by UTF-16 code unit", () => {
    expect(canonicalJson({ b: 1, B: 2, é: 3, "😀": 4, a: 5 })).toBe(
      '{"B":2,"a":5,"b":1,"é":3,"😀":4}',
    );
  });

  it("serializes scalars like JSON.stringify", () => {
    expect(canonicalJson([null, true, false, 0, -0, 1.5, 1e21, 5e-7, 'a"\\\n\u0001'])).toBe(
      '[null,true,false,0,0,1.5,1e+21,5e-7,"a\\"\\\\\\n\\u0001"]',
    );
  });

  it("omits object members whose value is undefined", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("accepts null-prototype objects", () => {
    const record = Object.assign(Object.create(null) as object, { z: 1, a: 2 });
    expect(canonicalJson(record)).toBe('{"a":2,"z":1}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined at the top level", undefined],
    ["undefined inside an array", [1, undefined]],
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
    ["a sparse array", [1, , 2]],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a class instance", new (class Box {})()],
    ["a lone surrogate value", "\udc00"],
    ["a lone surrogate key", { "\ud800": 1 }],
  ])("rejects %s", (_label, value) => {
    expectCryptoError(() => canonicalJson(value), InvalidCryptoInputError);
  });

  it("rejects nesting deeper than the limit", () => {
    let deep: unknown = 1;
    for (let depth = 0; depth <= MAX_CANONICAL_JSON_DEPTH; depth += 1) deep = [deep];
    expectCryptoError(() => canonicalJson(deep), InvalidCryptoInputError);
    let allowed: unknown = 1;
    for (let depth = 0; depth < MAX_CANONICAL_JSON_DEPTH; depth += 1) allowed = [allowed];
    expect(canonicalJson(allowed)).toMatch(/^\[+1\]+$/);
  });
});
