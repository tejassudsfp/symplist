import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("@symplist/search", () => {
  it("loads its entry point", () => {
    expect(entry).toBeTypeOf("object");
  });
});
