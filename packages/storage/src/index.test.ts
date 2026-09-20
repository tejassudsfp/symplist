import { describe, expect, it } from "vitest";
import type { ObjectStore, PutObjectResult } from "./index.ts";

describe("storage interface", () => {
  it("reports conditional puts on existing keys as exists", async () => {
    const exists: PutObjectResult = { status: "exists" };
    const store: Pick<ObjectStore, "put"> = { put: async () => exists };
    await expect(
      store.put({ key: "u/owner/kind/x", body: new Uint8Array(), ifNoneMatch: "*" }),
    ).resolves.toEqual(exists);
  });
});
