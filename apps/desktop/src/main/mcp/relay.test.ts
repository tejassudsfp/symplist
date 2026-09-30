// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { silentMainLog } from "../log.ts";
import { relayCapabilityHeader } from "./policy.ts";
import { type McpRelay, startMcpRelay } from "./relay.ts";

const running: McpRelay[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((relay) => relay.stop()));
});

/** A fake `/mcp`: records what it was sent and answers what the test asked for. */
function upstream(
  answer: (call: { headers: Headers; body: string }) => Response | Promise<Response>,
) {
  const calls: { headers: Headers; body: string }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const call = {
      headers: new Headers(init?.headers as HeadersInit),
      body: Buffer.from((init?.body ?? "") as Uint8Array).toString("utf8"),
    };
    calls.push(call);
    return await answer(call);
  };
  return { calls, fetchImpl };
}

async function relay(
  options: Partial<Parameters<typeof startMcpRelay>[0]> & {
    readonly fetchImpl: typeof fetch;
  },
) {
  const failures: string[] = [];
  const started = await startMcpRelay({
    target: "https://api.example.test/mcp",
    bearer: () => "sym_0198_key",
    onFailure: (failure) => failures.push(failure),
    log: silentMainLog,
    ...options,
  });
  running.push(started);
  return { relay: started, failures };
}

function post(started: McpRelay, init: RequestInit & { readonly capability?: string } = {}) {
  const { capability = started.capability, headers, ...rest } = init;
  return fetch(started.url, {
    method: "POST",
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    ...rest,
    headers: {
      [relayCapabilityHeader]: capability,
      "content-type": "application/json",
      ...(headers as Record<string, string> | undefined),
    },
  });
}

describe("the loopback MCP relay", () => {
  it("swaps the capability header for the bearer and sends no Origin", async () => {
    const cloud = upstream(
      () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { relay: started } = await relay({ fetchImpl: cloud.fetchImpl });
    const response = await post(started, { headers: { "mcp-protocol-version": "2026-07-28" } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    const call = cloud.calls[0];
    expect(call?.headers.get("authorization")).toBe("Bearer sym_0198_key");
    // The capability authorized the hop that just happened; it means nothing to the cloud.
    expect(call?.headers.get(relayCapabilityHeader)).toBe(null);
    /*
     * No Origin of our own: `/mcp` is route class `mcp`, whose `allowlisted_if_present` check refuses any
     * Origin that is not WEB_ORIGIN or API_ORIGIN, and the framework's validator passes a request with
     * none. This is also why a page in the renderer could never call `/mcp` even holding the key.
     */
    expect(call?.headers.get("origin")).toBe(null);
    // Negotiated once and then sent on every request; dropping it would silently downgrade the revision.
    expect(call?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(call?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  });

  it("binds loopback only", async () => {
    const cloud = upstream(() => new Response("{}"));
    const { relay: started } = await relay({ fetchImpl: cloud.fetchImpl });
    expect(started.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(started.url.endsWith("/mcp")).toBe(true);
    // A token worth putting in an ACP payload: long, random, and dead after this launch.
    expect(started.capability.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses a caller without the capability, or one that looks like a page", async () => {
    const cloud = upstream(() => new Response("{}"));
    const { relay: started } = await relay({ fetchImpl: cloud.fetchImpl });
    expect((await post(started, { capability: "wrong" })).status).toBe(401);
    expect((await post(started, { headers: { origin: "http://127.0.0.1:3000" } })).status).toBe(
      403,
    );
    expect(
      (
        await fetch(started.url, {
          method: "GET",
          headers: { [relayCapabilityHeader]: started.capability },
        })
      ).status,
    ).toBe(405);
    expect(cloud.calls).toHaveLength(0);
  });

  it("answers 401 without calling the cloud when there is no usable grant", async () => {
    const cloud = upstream(() => new Response("{}"));
    const { relay: started, failures } = await relay({
      fetchImpl: cloud.fetchImpl,
      bearer: () => null,
    });
    expect((await post(started)).status).toBe(401);
    expect(cloud.calls).toHaveLength(0);
    // The same state a revoked key produces, which is the one the app already knows how to show.
    expect(failures).toEqual(["invalid_token"]);
  });

  it("relays an SSE answer verbatim, with its content type", async () => {
    const stream = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    const cloud = upstream(
      () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const { relay: started } = await relay({ fetchImpl: cloud.fetchImpl });
    const response = await post(started);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(stream);
  });

  it("classifies the three failures and never rewrites the body", async () => {
    const toolError = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: '{"error":{"code":"document.budget_exhausted"}}' }],
        isError: true,
      },
    });
    for (const [answer, expected] of [
      [new Response("", { status: 401 }), "invalid_token"],
      [new Response("", { status: 403 }), "forbidden"],
      [new Response("", { status: 429 }), "throttled"],
      [new Response(toolError, { status: 200 }), "throttled"],
    ] as const) {
      const cloud = upstream(() => answer.clone());
      const { relay: started, failures } = await relay({ fetchImpl: cloud.fetchImpl });
      const response = await post(started);
      expect(failures).toEqual([expected]);
      // Classification is read-only: the model sees exactly what the cloud said, including its own code.
      expect(await response.text()).toBe(await answer.clone().text());
    }
  });

  /**
   * The answer to the api's 2 req/s D1 lane. One MCP tool call costs roughly three D1 requests, so a
   * harness that fans out subagents would blow past the burst window; one in-flight forwarded request
   * keeps it inside without a single retry.
   */
  it("forwards one request at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const cloud = upstream(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return new Response("{}", { status: 200 });
    });
    const { relay: started } = await relay({ fetchImpl: cloud.fetchImpl });
    const responses = await Promise.all([
      post(started),
      post(started),
      post(started),
      post(started),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(cloud.calls).toHaveLength(4);
    expect(peak).toBe(1);
  });

  it("keeps serving after a forward fails", async () => {
    let first = true;
    const cloud = upstream(() => {
      if (first) {
        first = false;
        throw new Error("network down");
      }
      return new Response("{}", { status: 200 });
    });
    const { relay: started } = await relay({ fetchImpl: cloud.fetchImpl });
    expect((await post(started)).status).toBe(502);
    // A poisoned serializer would hang every call behind the failure instead of answering this one.
    expect((await post(started)).status).toBe(200);
  });
});
