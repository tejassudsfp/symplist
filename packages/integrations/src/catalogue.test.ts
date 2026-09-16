import { defaultFakeToolkits, FakeComposioClient } from "@symplist/testing";
import { describe, expect, it, vi } from "vitest";
import { ToolkitCatalogue } from "./catalogue.ts";
import { normalizeIntegrationError } from "./errors.ts";

describe("live-only toolkit catalogue", () => {
  it("paginates beyond 1,000, hides unmanaged OAuth and refreshes its memory cache", async () => {
    let now = 1;
    const template = defaultFakeToolkits[0];
    if (!template) throw new Error("fixture");
    const client = new FakeComposioClient({
      toolkits: Array.from({ length: 1005 }, (_, index) => ({
        ...template,
        slug: `service_${index}`,
      })),
    });
    const catalogue = new ToolkitCatalogue(client.getClient(), () => now);
    expect(await catalogue.list()).toHaveLength(1005);
    expect(client.toolkitListCalls).toHaveLength(2);
    await catalogue.list();
    expect(client.toolkitListCalls).toHaveLength(2);
    now += 120001;
    await catalogue.list();
    expect(client.toolkitListCalls).toHaveLength(4);
  });

  it("filters auth capabilities and bounds looping cursors", async () => {
    const list = vi.fn(async () => ({
      items: [
        { slug: "hidden", name: "Hidden", auth_schemes: ["OAUTH2"] },
        { slug: "hosted", name: "Hosted key", auth_schemes: ["API_KEY"] },
        { slug: "public", name: "Public", no_auth: true },
      ],
      next_cursor: null,
    }));
    expect(await new ToolkitCatalogue({ toolkits: { list } }).list()).toEqual([
      { slug: "hosted", name: "Hosted key", description: "", auth: "api_key" },
      { slug: "public", name: "Public", description: "", auth: "none" },
    ]);
    const cyclic = vi.fn(async () => ({ items: [], next_cursor: "same" }));
    await expect(new ToolkitCatalogue({ toolkits: { list: cyclic } }).list()).rejects.toThrow(
      "integration.invalid_response",
    );
    expect(cyclic).toHaveBeenCalledTimes(2);
  });
});

describe("provider error boundary", () => {
  it("honors HTTP-date Retry-After as well as delta seconds", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 16));
    try {
      expect(
        normalizeIntegrationError({
          status: 429,
          headers: { "retry-after": "Wed, 16 Sep 2026 00:00:17 GMT" },
        }).details.retryAfter,
      ).toBe(17);
      expect(
        normalizeIntegrationError({
          status: 429,
          headers: { "retry-after": "Wed, 16 Sep 2026 00:00:00 GMT" },
        }).details.retryAfter,
      ).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
  it("normalizes both SDK and raw client errors without retaining private bodies or causes", () => {
    for (const source of [
      {
        status: 429,
        headers: { "retry-after": "13" },
        error: { slug: "RateLimit", request_id: "req_123", message: "private marker" },
      },
      {
        statusCode: 429,
        cause: {
          headers: new Headers({ "retry-after": "13" }),
          error: { slug: "RateLimit", request_id: "req_123", message: "private marker" },
        },
      },
    ]) {
      const error = normalizeIntegrationError(source);
      expect(error).toMatchObject({
        code: "integration.rate_limited",
        details: { status: 429, retryAfter: 13, slug: "RateLimit", requestId: "req_123" },
      });
      expect(JSON.stringify(error)).not.toContain("private marker");
      expect(error.cause).toBeUndefined();
    }
    expect(normalizeIntegrationError(new Error("private marker"), true).message).toBe(
      "integration.uncertain",
    );
  });
});
