import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/lib/api";
import { createConnectionsApi } from "./api.tsx";
import { id, secretMarker, taskId } from "./test-support.tsx";

function setup(response: unknown) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(
      JSON.stringify(
        String(input).endsWith("/v1/auth/csrf") ? { token: "session-csrf" } : response,
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const client = new ApiClient({ baseUrl: "https://api.example", fetch, isBrowser: () => true });
  return { api: createConnectionsApi(() => client), requests };
}
const signal = () => new AbortController().signal;

describe("connections HTTP boundary", () => {
  it("uses the live catalogue route with cookies and cancellation", async () => {
    const { api, requests } = setup({ enabled: true, items: [] });
    const abort = signal();
    expect(await api.catalogue(abort)).toEqual({ enabled: true, items: [] });
    expect(requests[0]).toMatchObject({
      url: "https://api.example/v1/connections/catalogue",
      init: { credentials: "include", signal: abort },
    });
  });
  it("adds CSRF and idempotency to provider authorization", async () => {
    const { api, requests } = setup({
      attemptId: id,
      url: "https://provider.example/authorize",
      expiresAt: 1,
      secretUnavailable: false,
    });
    await api.start({ toolkit: "gmail", replacesConnectionId: id }, "same-start", signal());
    const sent = requests[1];
    expect(sent?.url).toBe("https://api.example/v1/connections");
    const headers = new Headers(sent?.init?.headers);
    expect(headers.get("X-Symplist-CSRF")).toBe("session-csrf");
    expect(headers.get("Idempotency-Key")).toBe("same-start");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      toolkit: "gmail",
      replacesConnectionId: id,
    });
  });
  it("creates one-time keys only through the owner app endpoint", async () => {
    const { api, requests } = setup({
      id,
      key: secretMarker,
      expiresAt: 1,
      secretUnavailable: false,
    });
    const value = await api.createKey(
      { name: "Agent", scopes: ["tasks:read"], taskIds: [taskId] },
      "create-key",
      signal(),
    );
    expect(value.key).toBe(secretMarker);
    expect(requests[1]?.url).toBe("https://api.example/v1/mcp/grants");
    expect(requests.map((entry) => entry.url).join(" ")).not.toContain(secretMarker);
    expect(new Headers(requests[1]?.init?.headers).get("Authorization")).toBeNull();
    expect(requests[1]?.init?.body).not.toContain(secretMarker);
  });
  it.each(["disconnect", "revoke"] as const)(
    "protects %s with CSRF, a stable key and an encoded segment",
    async (method) => {
      const { api, requests } = setup(
        method === "disconnect" ? { id, status: "disconnected" } : { id, revoked: true },
      );
      await api[method]("id/with/slash", "mutation-key", signal());
      const sent = requests[1];
      expect(sent?.url).toContain("id%2Fwith%2Fslash");
      expect(sent?.init?.method).toBe("DELETE");
      expect(new Headers(sent?.init?.headers).get("X-Symplist-CSRF")).toBe("session-csrf");
      expect(new Headers(sent?.init?.headers).get("Idempotency-Key")).toBe("mutation-key");
    },
  );
  it("records consent decisions through app CSRF, not a client-supplied redirect", async () => {
    const { api, requests } = setup({ requestId: id, secretUnavailable: true });
    await api.decide(id, { decision: "allow", taskIds: null }, "decision-key", signal());
    expect(requests[1]?.url).toBe(`https://api.example/v1/oauth/requests/${id}/decision`);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      decision: "allow",
      taskIds: null,
    });
    expect(new Headers(requests[1]?.init?.headers).get("X-Symplist-CSRF")).toBe("session-csrf");
  });
  it("rejects malformed catalogue data instead of rendering it", async () => {
    const { api } = setup({ enabled: true, items: [{ slug: "../bad", name: "Injected" }] });
    await expect(api.catalogue(signal())).rejects.toThrow();
  });
  it("accepts the redacted one-time replay without inventing a secret", async () => {
    const { api } = setup({
      id,
      expiresAt: 1,
      secretUnavailable: true,
      notice: "secret.already_issued",
    });
    expect(
      await api.createKey(
        { name: "Agent", scopes: ["tasks:read"], taskIds: null },
        "same",
        signal(),
      ),
    ).toEqual({ id, expiresAt: 1, secretUnavailable: true, notice: "secret.already_issued" });
  });
});
