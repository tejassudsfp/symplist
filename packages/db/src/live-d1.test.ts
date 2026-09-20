import { describe, it } from "vitest";
import {
  describeDbClientContract,
  describeLiveD1RateLimitScope,
  describeRawD1ParamTypes,
  liveD1Settings,
  observingFetch,
} from "../../testing/src/contracts/db/db-client-contract.ts";
import { D1CircuitBreaker } from "./circuit-breaker.ts";
import { CLOUDFLARE_API_BASE_URL, createD1RestClient } from "./d1-rest-client.ts";
import { createApiLane, RateLane } from "./rate-limit.ts";

// Live D1 checks (§3.2): run only with LIVE_D1=1 and credentials, against a development database.
// They create and drop scratch tables named contract_<random>.
const live = liveD1Settings();

if ("settings" in live) {
  const { settings } = live;
  describeDbClientContract("live D1 over REST", async () => {
    const observed = observingFetch((url, init) => fetch(url, init));
    const client = createD1RestClient({
      accountId: settings.accountId,
      databaseId: settings.databaseId,
      apiToken: settings.apiToken,
      lane: createApiLane(),
      circuit: new D1CircuitBreaker(),
      fetch: observed.fetch,
    });
    return { client, responses: observed.responses };
  });
  describeRawD1ParamTypes("live D1", {
    url: `${CLOUDFLARE_API_BASE_URL}/accounts/${settings.accountId}/d1/database/${settings.databaseId}/query`,
    apiToken: settings.apiToken,
    fetch: (url, init) => fetch(url, init),
  });
  describeLiveD1RateLimitScope(
    (apiToken, transport) =>
      createD1RestClient({
        accountId: settings.accountId,
        databaseId: settings.databaseId,
        apiToken,
        lane: new RateLane({ name: "live-scope", ratePerSecond: 1, burst: 5, maxWaitMs: 10_000 }),
        circuit: new D1CircuitBreaker(),
        fetch: transport,
      }),
    settings,
  );
} else {
  describe.skip(`live D1 contract (skipped: ${live.skipReason})`, () => {
    it("runs the DbClient contract against live D1", () => {});
  });
}
