import type { FactoryProvider } from "@nestjs/common";
import { type D1Counters, processCircuitBreaker } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { D1_COUNTERS, dbProviders } from "./db.providers.ts";

afterEach(() => {
  processCircuitBreaker.reset();
});

describe("api D1 counters (§3.1)", () => {
  it("report the state of the process-wide circuit the api D1 client uses", () => {
    const provider = dbProviders.find(
      (candidate): candidate is FactoryProvider =>
        typeof candidate === "object" &&
        "provide" in candidate &&
        candidate.provide === D1_COUNTERS,
    );
    const counters = provider?.useFactory() as D1Counters;
    expect(counters).toMatchObject({ runtime: "api", lane: "api" });
    expect(counters.snapshot()).toMatchObject({ circuitOpen: 0 });

    const openedBefore = processCircuitBreaker.state().openedCount;
    processCircuitBreaker.open(60_000, "http_429");
    expect(counters.snapshot()).toMatchObject({
      circuitOpen: 1,
      circuitOpenedTotal: openedBefore + 1,
    });

    processCircuitBreaker.reset();
    expect(counters.snapshot()).toMatchObject({ circuitOpen: 0 });
  });
});
