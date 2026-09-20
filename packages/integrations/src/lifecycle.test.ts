import { describe, expect, it, vi } from "vitest";
import { createComposioClient } from "./client.ts";
import { ComposioLifecycleProvider } from "./lifecycle.ts";

describe("installed SDK lifecycle boundary", () => {
  it("uses raw no-retry clones for auth config and hosted link creation", async () => {
    const client = createComposioClient("test-key");
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify(
          body.auth_config
            ? { toolkit: { slug: "gmail" }, auth_config: { id: "ac_1" } }
            : {
                connected_account_id: "ca_1",
                redirect_url: "https://connect.composio.dev/link",
                link_token: "never_return",
                expires_at: "later",
              },
        ),
        { headers: { "content-type": "application/json" } },
      );
    });
    const raw = client.getClient().withOptions({ fetch: fetcher });
    vi.spyOn(client, "getClient").mockReturnValue(raw);
    const api = new ComposioLifecycleProvider(client, "test-key");
    expect(await api.createAuthConfig("gmail", "managed")).toBe("ac_1");
    expect(await api.link("owner", "ac_1", "https://api.example.test/callback", "Work")).toEqual({
      id: "ca_1",
      url: "https://connect.composio.dev/link",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      user_id: "owner",
      auth_config_id: "ac_1",
      callback_url: "https://api.example.test/callback",
      alias: "Work",
    });
  });

  it("does not retry creation on 500 and discards the provider response", async () => {
    const client = createComposioClient("test-key");
    const fetcher = vi.fn(async () => new Response("private marker", { status: 500 }));
    const raw = client.getClient().withOptions({ fetch: fetcher });
    vi.spyOn(client, "getClient").mockReturnValue(raw);
    await expect(
      new ComposioLifecycleProvider(client, "test-key").link(
        "owner",
        "ac_1",
        "https://api.example.test/callback",
      ),
    ).rejects.toThrow("integration.provider_failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("attests a callback token at a fixed endpoint and never fetches the supplied URI", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new ComposioLifecycleProvider(
      createComposioClient("test-key"),
      "test-key",
      fetcher,
    );
    await api.complete("http://169.254.169.254/private", "owner");
    expect(fetcher).toHaveBeenCalledWith(
      "https://backend.composio.dev/api/v3.1/connected_accounts/complete_auth",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ session_uri: "http://169.254.169.254/private", user_id: "owner" }),
      }),
    );
  });
});
