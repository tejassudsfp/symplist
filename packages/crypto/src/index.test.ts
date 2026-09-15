import { describe, expect, it } from "vitest";
import { generateToken, NotImplementedError } from "./index.ts";

describe("crypto interface stubs", () => {
  it("fail loudly until implemented", () => {
    expect(() => generateToken()).toThrow(NotImplementedError);
  });
});
