import { describe, expect, it } from "vitest";
import * as docs from "./index.ts";

describe("@symplist/docs", () => {
  it("exposes the browser-safe markdown entry", () => {
    expect(docs.markdown).toBeTypeOf("object");
  });
});
