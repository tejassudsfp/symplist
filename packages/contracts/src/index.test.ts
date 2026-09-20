import { describe, expect, it } from "vitest";
import {
  errorCodes,
  errorCodesByOwner,
  errorEnvelopeSchema,
  featureIds,
  idSchema,
  toolContracts,
  toolContractsByFeature,
  wsEvents,
  wsEventsByFeature,
} from "./index.ts";

const countKeys = (maps: Record<string, object>) =>
  Object.values(maps).reduce((total, map) => total + Object.keys(map).length, 0);

describe("contracts seams", () => {
  it("uses the canonical feature ids for every per-feature map", () => {
    expect(featureIds).toEqual([
      "access",
      "workspace",
      "documents",
      "search",
      "simon",
      "scheduling",
      "vault",
      "sharing",
      "connections",
      "analytics",
    ]);
    expect(Object.keys(wsEventsByFeature)).toEqual([...featureIds]);
    expect(Object.keys(toolContractsByFeature)).toEqual([...featureIds]);
    expect(Object.keys(errorCodesByOwner)).toEqual(["common", ...featureIds]);
  });

  it("never lets two owners declare the same error code, event type or tool name", () => {
    expect(Object.keys(errorCodes)).toHaveLength(countKeys(errorCodesByOwner));
    expect(Object.keys(wsEvents)).toHaveLength(countKeys(wsEventsByFeature));
    expect(Object.keys(toolContracts)).toHaveLength(countKeys(toolContractsByFeature));
  });

  it("validates the error envelope and UUIDv7 ids", () => {
    const envelope = { error: { code: "not_found", message: "Not found", requestId: "req_1" } };
    expect(errorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(idSchema.safeParse("0199a5a0-7c1e-7b3a-9f2e-3c4d5e6f7a8b").success).toBe(true);
    expect(idSchema.safeParse("not-an-id").success).toBe(false);
  });
});
