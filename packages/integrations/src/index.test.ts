import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("@symplist/integrations", () => {
  it("loads its entry point", () => {
    expect(entry).toBeTypeOf("object");
  });
});
