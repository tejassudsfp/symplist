import { describe, expect, it } from "vitest";
import * as client from "./index.ts";
import * as server from "./server.ts";

describe("@symplist/analytics", () => {
  it("loads the browser-safe and server entry points", () => {
    expect(client).toBeTypeOf("object");
    expect(server).toBeTypeOf("object");
  });
});
