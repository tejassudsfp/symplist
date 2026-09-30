// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { silentMainLog } from "../log.ts";
import { type DeviceGrant, deviceGrantSource } from "./grant-source.ts";
import { McpAccess } from "./index.ts";
import { relayCapabilityHeader, revokedNotice, throttledNotice } from "./policy.ts";
import { grantVerdict, parseGrantRows } from "./reconcile.ts";

const now = 1_800_000_000_000;

/** A grant source whose behaviour a test can set, standing in for the cloud lane's store. */
function source(initial: DeviceGrant | null) {
  let grant = initial;
  let replacements = 0;
  return {
    calls: () => replacements,
    set: (next: DeviceGrant | null) => {
      grant = next;
    },
    source: {
      current: () => grant,
      replace: async () => {
        replacements += 1;
        grant = {
          grantId: `g${replacements}`,
          key: `sym_new_${replacements}`,
          expiresAt: now + 86_400_000,
        };
      },
    },
  };
}

function listing(rows: { id: string; revokedAt?: number | null; expiresAt?: number }[]) {
  return JSON.stringify({
    server: "https://api.example.test/mcp",
    grants: rows.map((row) => ({
      id: row.id,
      kind: "api_key",
      name: "Symplist for macOS",
      scopes: ["tasks:read", "tasks:write"],
      taskIds: null,
      createdAt: now - 1000,
      lastUsedAt: null,
      expiresAt: row.expiresAt ?? now + 86_400_000,
      revokedAt: row.revokedAt ?? null,
    })),
  });
}

const accesses: McpAccess[] = [];
afterEach(async () => {
  await Promise.all(accesses.splice(0).map((access) => access.stop()));
});

async function access(options: {
  readonly grant: DeviceGrant | null;
  readonly body?: string;
  readonly status?: number;
  readonly http?: (request: { path: string }) => Promise<{ status: number; body: string }>;
  readonly upstream?: typeof fetch;
}) {
  const store = source(options.grant);
  const states: { state: string; notice: string | null }[] = [];
  const service = new McpAccess({
    grants: store.source,
    http:
      options.http ??
      (async () => ({ status: options.status ?? 200, body: options.body ?? listing([]) })),
    target: "https://api.example.test/mcp",
    log: silentMainLog,
    now: () => now,
    onChange: (state) => states.push({ state: state.state, notice: state.notice }),
    fetchImpl: options.upstream ?? (async () => new Response("{}", { status: 200 })),
  });
  accesses.push(service);
  await service.start();
  return { service, store, states };
}

const live: DeviceGrant = { grantId: "g0", key: "sym_live", expiresAt: now + 86_400_000 };

describe("reconciliation against the grants listing", () => {
  it("reads the rows it needs and tolerates fields it has never seen", () => {
    const rows = parseGrantRows(listing([{ id: "g0" }]));
    expect(rows).toEqual([{ id: "g0", revokedAt: null, expiresAt: now + 86_400_000 }]);
    expect(parseGrantRows("not json")).toEqual([]);
    expect(parseGrantRows(JSON.stringify({ grants: "nope" }))).toEqual([]);
    expect(
      parseGrantRows(JSON.stringify({ grants: [{ id: "g0", expiresAt: 1, somethingNew: true }] })),
    ).toEqual([{ id: "g0", revokedAt: null, expiresAt: 1 }]);
  });

  it("tells the three ways a grant stops being usable apart", () => {
    expect(grantVerdict("g0", parseGrantRows(listing([{ id: "g0" }])), now)).toBe("usable");
    expect(grantVerdict("g0", parseGrantRows(listing([{ id: "other" }])), now)).toBe("missing");
    expect(
      grantVerdict("g0", parseGrantRows(listing([{ id: "g0", revokedAt: now - 1 }])), now),
    ).toBe("revoked");
    expect(grantVerdict("g0", parseGrantRows(listing([{ id: "g0", expiresAt: now }])), now)).toBe(
      "expired",
    );
  });
});

describe("the assistant's access to the workspace", () => {
  it("is connected with a live grant and signed out without one", async () => {
    const withGrant = await access({ grant: live, body: listing([{ id: "g0" }]) });
    expect(withGrant.service.state()).toEqual({
      state: "connected",
      grantId: "g0",
      expiresAt: live.expiresAt,
      notice: null,
    });
    const without = await access({ grant: null });
    expect(without.service.state().state).toBe("signed_out");
  });

  it("enters reconnect when the web UI revoked the grant, on the very next focus", async () => {
    const { service, states } = await access({
      grant: live,
      body: listing([{ id: "g0", revokedAt: now - 1 }]),
    });
    expect((await service.reconcile()).state).toBe("reconnect");
    expect(service.state().notice).toBe(revokedNotice);
    expect(states.at(-1)?.state).toBe("reconnect");
  });

  it("treats an unreachable cloud as no news, not as a revocation", async () => {
    const { service } = await access({
      grant: live,
      http: async () => {
        throw new Error("offline");
      },
    });
    expect((await service.reconcile()).state).toBe("connected");
    const refused = await access({ grant: live, status: 503 });
    expect((await refused.service.reconcile()).state).toBe("connected");
  });

  it("repairs itself on request and not on its own", async () => {
    const { service, store } = await access({
      grant: live,
      body: listing([{ id: "g0", revokedAt: now - 1 }]),
    });
    await service.reconcile();
    // A 401 does not mint: minting automatically would hand back access the user had just taken away.
    expect(store.calls()).toBe(0);
    expect((await service.reconnect()).state).toBe("connected");
    expect(store.calls()).toBe(1);
    expect(service.state().grantId).toBe("g1");
  });

  /*
   * The relay's bearer is gated on the same flag the UI shows, so a grant the app knows is dead is never
   * forwarded with — the harness gets the 401 that produces a first-class state instead of an api refusal.
   */
  it("stops forwarding with a grant it knows is dead", async () => {
    let forwarded = 0;
    const { service } = await access({
      grant: live,
      body: listing([{ id: "g0", revokedAt: now - 1 }]),
      upstream: async () => {
        forwarded += 1;
        return new Response("{}", { status: 200 });
      },
    });
    const server = service.mcpServer();
    const send = () =>
      fetch(server.url, {
        method: "POST",
        headers: {
          [relayCapabilityHeader]: server.headers[0]?.value ?? "",
          "content-type": "application/json",
        },
        body: "{}",
      });
    expect((await send()).status).toBe(200);
    await service.reconcile();
    expect((await send()).status).toBe(401);
    expect(forwarded).toBe(1);
  });

  it("reports throttling as a passing notice over a connection that still works", async () => {
    const { service } = await access({
      grant: live,
      body: listing([{ id: "g0" }]),
      upstream: async () => new Response("", { status: 429 }),
    });
    const server = service.mcpServer();
    await fetch(server.url, {
      method: "POST",
      headers: {
        [relayCapabilityHeader]: server.headers[0]?.value ?? "",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(service.state()).toMatchObject({ state: "connected", notice: throttledNotice });
  });

  it("refuses to describe an MCP server before the relay is running", () => {
    const service = new McpAccess({
      grants: { current: () => live, replace: async () => undefined },
      http: async () => ({ status: 200, body: listing([]) }),
      target: "https://api.example.test/mcp",
      log: silentMainLog,
    });
    // `dsh-acp` hardcodes `failOnStartupError: true`, so this has to be a state the app can name rather
    // than a config error surfacing from inside ACP.
    expect(() => service.mcpServer()).toThrow(/relay is not running/);
  });
});

describe("the seam onto the cloud lane's grant store", () => {
  it("revokes before minting, and mints nothing without a session", async () => {
    const order: string[] = [];
    const store = {
      current: () => live,
      beforeSignOut: async () => {
        order.push("revoke");
      },
      cleared: async () => {
        order.push("clear");
      },
      established: async () => {
        order.push("mint");
      },
    };
    await deviceGrantSource(store, () => ({ destination: "app", accessGeneration: 1 })).replace();
    expect(order).toEqual(["revoke", "clear", "mint"]);

    order.length = 0;
    // Minting needs a fresh admitted session; without one, `signed_out` is the right answer.
    await deviceGrantSource(store, () => null).replace();
    expect(order).toEqual(["revoke", "clear"]);
  });
});
