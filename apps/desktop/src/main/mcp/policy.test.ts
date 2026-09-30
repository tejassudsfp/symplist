// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  relayAdmission,
  relayCapabilityHeader,
  statusFailure,
  toolResultFailure,
} from "./policy.ts";

const capability = "a".repeat(43);

function inbound(overrides: Partial<Parameters<typeof relayAdmission>[0]> = {}) {
  return {
    method: "POST",
    url: "/mcp",
    headers: { [relayCapabilityHeader]: capability } as Record<string, string | string[]>,
    ...overrides,
  };
}

describe("relay admission", () => {
  it("forwards a capability-bearing POST to /mcp and nothing else", () => {
    expect(relayAdmission(inbound(), capability)).toEqual({ kind: "forward" });
    expect(relayAdmission(inbound({ url: "/mcp?x=1" }), capability)).toEqual({ kind: "forward" });
    expect(relayAdmission(inbound({ url: "/other" }), capability).kind).toBe("refuse");
    // The 1.x transport's SSE GET and session-terminating DELETE: refused here rather than forwarded to
    // an endpoint that answers them 405 anyway.
    for (const method of ["GET", "DELETE", "PUT", undefined]) {
      const decision = relayAdmission(inbound({ method }), capability);
      expect(decision.kind === "refuse" && decision.status).toBe(405);
    }
  });

  it("refuses a missing or wrong capability token", () => {
    expect(relayAdmission(inbound({ headers: {} }), capability)).toEqual({
      kind: "refuse",
      status: 401,
      reason: "capability_missing",
    });
    const wrong = relayAdmission(
      inbound({ headers: { [relayCapabilityHeader]: "b".repeat(43) } }),
      capability,
    );
    expect(wrong.kind === "refuse" && wrong.status).toBe(401);
    // A prefix of the real token is not a partial match.
    const short = relayAdmission(
      inbound({ headers: { [relayCapabilityHeader]: capability.slice(0, 20) } }),
      capability,
    );
    expect(short.kind === "refuse" && short.status).toBe(401);
  });

  /*
   * The property that keeps a page out of the relay. The renderer is dataless by design, but it is also a
   * loopback document that could otherwise discover the port — and so could a remote page via DNS
   * rebinding. Both send one of these headers; the harness's Node client sends neither.
   */
  it("refuses anything that came from a page, token or not", () => {
    for (const headers of [
      { [relayCapabilityHeader]: capability, origin: "http://127.0.0.1:3000" },
      { [relayCapabilityHeader]: capability, origin: "null" },
      { [relayCapabilityHeader]: capability, "sec-fetch-site": "cross-site" },
      { [relayCapabilityHeader]: capability, "sec-fetch-site": "same-origin" },
    ]) {
      const decision = relayAdmission(inbound({ headers }), capability);
      expect(decision.kind === "refuse" && decision.status).toBe(403);
    }
  });
});

describe("failure classification", () => {
  it("maps the transport statuses to the three states", () => {
    expect(statusFailure(401)).toBe("invalid_token");
    expect(statusFailure(403)).toBe("forbidden");
    expect(statusFailure(429)).toBe("throttled");
    expect(statusFailure(503)).toBe("throttled");
    expect(statusFailure(200)).toBe(null);
    expect(statusFailure(500)).toBe(null);
  });

  /**
   * A tool that failed answers HTTP 200 with an `isError` result whose text holds
   * `{"error":{"code":"…"}}` — see `safe()` in `apps/api/src/modules/mcp/mcp-tools.ts`. Without reading
   * that, a revoked grant mid-session and a spent read quota would both be invisible to the app.
   */
  it("reads an error code out of a tool result, in JSON and in SSE framing", () => {
    const result = (code: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: { code } }) }],
          isError: true,
        },
      });
    expect(toolResultFailure(result("mcp.invalid_token"))).toBe("invalid_token");
    expect(toolResultFailure(result("mcp.forbidden"))).toBe("forbidden");
    expect(toolResultFailure(result("rate.limited"))).toBe("throttled");
    expect(toolResultFailure(result("document.budget_exhausted"))).toBe("throttled");
    expect(toolResultFailure(`event: message\ndata: ${result("rate.limited")}\n\n`)).toBe(
      "throttled",
    );
  });

  it("classifies anything it does not recognise as no failure at all", () => {
    // Best-effort by contract: the body still reaches the model byte for byte either way.
    expect(toolResultFailure("not json")).toBe(null);
    expect(toolResultFailure("")).toBe(null);
    expect(
      toolResultFailure(JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } })),
    ).toBe(null);
    expect(
      toolResultFailure(
        JSON.stringify({
          result: {
            content: [{ type: "text", text: '{"error":{"code":"internal"}}' }],
            isError: true,
          },
        }),
      ),
    ).toBe(null);
    // A successful document read whose text merely mentions the words is not a failure.
    expect(
      toolResultFailure(
        JSON.stringify({
          result: {
            content: [{ type: "text", text: "the section discusses rate.limited handling" }],
          },
        }),
      ),
    ).toBe(null);
  });
});
