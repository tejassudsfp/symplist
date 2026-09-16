import { describe, expect, it, vi } from "vitest";
import {
  ClientMetadataLoader,
  parseClientMetadata,
  publicMetadataAddress,
  redirectUriMatches,
  validRedirectUri,
} from "./client-metadata.ts";

const clientId = "https://agents.example.test/client.json";
const document = {
  client_id: clientId,
  client_name: "Maya's agent",
  redirect_uris: ["http://127.0.0.1/callback"],
  application_type: "native",
  token_endpoint_auth_method: "none",
};

describe("client metadata SSRF boundary", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
    "not-an-address",
  ])("rejects non-public address %s", (address) => {
    expect(publicMetadataAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "accepts public address %s",
    (address) => {
      expect(publicMetadataAddress(address)).toBe(true);
    },
  );

  it("resolves once and hands the exact vetted address to the transport", async () => {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const get = vi.fn(async () => ({ body: JSON.stringify(document), maxAge: 300 }));
    const loader = new ClientMetadataLoader({ resolve, get });
    expect(await loader.load(clientId)).toMatchObject({
      clientId,
      name: "Maya's agent",
      loopbackOnly: true,
      metadataHost: "agents.example.test",
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("agents.example.test");
    expect(get.mock.calls[0]).toEqual([
      new URL(clientId),
      { address: "93.184.216.34", family: 4 },
      expect.any(AbortSignal),
    ]);
    await loader.load(clientId);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects mixed public/private DNS answers before opening any socket", async () => {
    const get = vi.fn();
    const loader = new ClientMetadataLoader({
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      get,
    });
    await expect(loader.load(clientId)).rejects.toThrow("oauth.invalid_client_metadata");
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    "http://agents.example.test/client.json",
    "https://agents.example.test:444/client.json",
    "https://name:secret@agents.example.test/client.json",
    "https://localhost/client.json",
    "https://agents.example.test./client.json",
    "https://agents.example.test/client.json#fragment",
    "https://agents.example.test\\@evil.test/",
  ])("rejects an unsafe URL before DNS: %s", async (url) => {
    const resolve = vi.fn();
    await expect(new ClientMetadataLoader({ resolve, get: vi.fn() }).load(url)).rejects.toThrow(
      "oauth.invalid_client_metadata",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("requires exact client identity and valid redirect metadata", async () => {
    for (const invalid of [
      { ...document, client_id: `${clientId}?other` },
      { ...document, redirect_uris: [] },
      { ...document, redirect_uris: ["http://external.example.test/callback"] },
      { ...document, token_endpoint_auth_method: "client_secret_basic" },
      { ...document, client_name: "" },
    ]) {
      expect(() => parseClientMetadata(invalid, clientId)).toThrow("oauth.invalid_client_metadata");
    }
  });

  it("caps cache at 24 hours and honors no-cache", async () => {
    let now = 0;
    const get = vi.fn(async () => ({ body: JSON.stringify(document), maxAge: 864000 }));
    const resolve = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]);
    const loader = new ClientMetadataLoader({ resolve, get }, () => now);
    await loader.load(clientId);
    now = 86_400_001;
    await loader.load(clientId);
    expect(get).toHaveBeenCalledTimes(2);
    const noCache = new ClientMetadataLoader({
      resolve,
      get: async () => ({ body: JSON.stringify(document), maxAge: 0 }),
    });
    await noCache.load(clientId);
    await noCache.load(clientId);
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it("rejects oversized responses and discards arbitrary provider error text", async () => {
    const resolve = async () => [{ address: "1.1.1.1", family: 4 }];
    const large = new ClientMetadataLoader({
      resolve,
      get: async () => ({ body: "private".repeat(2000), maxAge: 0 }),
    });
    await expect(large.load(clientId)).rejects.toThrow("oauth.invalid_client_metadata");
    const failure = new ClientMetadataLoader({
      resolve,
      get: async () => {
        throw new Error("private detail");
      },
    });
    const error = await failure.load(clientId).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "oauth.invalid_client_metadata" });
    expect(error).not.toHaveProperty("cause");
  });
});

describe("OAuth redirect matching", () => {
  it.each(["http://127.0.0.1/callback", "http://localhost/callback", "http://[::1]/callback"])(
    "permits a variable loopback port, not a different path: %s",
    (registered) => {
      const url = new URL(registered);
      url.port = "43121";
      expect(redirectUriMatches(url.href, [registered])).toBe(true);
      url.pathname = "/other";
      expect(redirectUriMatches(url.href, [registered])).toBe(false);
    },
  );

  it("matches HTTPS exactly and rejects credentials, fragments, non-loopback HTTP and schemes", () => {
    const https = "https://client.example.test/callback";
    expect(redirectUriMatches(https, [https])).toBe(true);
    expect(redirectUriMatches(`${https}?next=evil`, [https])).toBe(false);
    expect(redirectUriMatches("https://client.example.test:444/callback", [https])).toBe(false);
    for (const uri of [
      "javascript:alert(1)",
      "http://client.example.test/callback",
      "https://user:pass@client.example.test/callback",
      `${https}#code`,
      "file:///etc/passwd",
    ])
      expect(validRedirectUri(uri)).toBe(false);
  });
});
