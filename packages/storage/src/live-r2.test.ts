import { describe, it } from "vitest";
import {
  describeObjectStoreContract,
  liveR2Settings,
} from "../../testing/src/contracts/storage/object-store-contract.ts";
import { R2ObjectStore } from "./r2-object-store.ts";

// Live R2 checks (§1, §17): run only with LIVE_R2=1 and credentials, against a development bucket.
// Objects live under contract-tests/<random>/ and are deleted afterwards.
const live = liveR2Settings();

if ("settings" in live) {
  const { settings } = live;
  describeObjectStoreContract("live R2", async () => {
    const maxBodyBytes = 1024 * 1024;
    return { store: new R2ObjectStore({ ...settings, maxBodyBytes }), maxBodyBytes };
  });
} else {
  describe.skip(`live R2 contract (skipped: ${live.skipReason})`, () => {
    it("runs the ObjectStore contract against live R2", () => {});
  });
}
