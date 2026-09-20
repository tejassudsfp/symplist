import { logger } from "@composio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposioClient, executionClient } from "./client.ts";

afterEach(() => vi.restoreAllMocks());

describe("installed Composio SDK boundary", () => {
  it("requires explicit credentials even if an ambient key is configured", () => {
    expect(() => createComposioClient("")).toThrow("integration.unavailable");
  });

  it("disables content-bearing logs on core and raw no-retry clients", async () => {
    const marker = "private-content-marker";
    const spies = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "debug"),
    ];
    const client = createComposioClient("test-only-placeholder");
    expect(executionClient(client)).toBe(client);
    const raw = client.getClient();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: marker } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    logger.error(marker);
    logger.debug({ arguments: marker });
    const noRetry = raw.withOptions({ maxRetries: 0, fetch });
    expect(noRetry.logLevel).toBe("off");
    await expect(
      noRetry.toolRouter.session.execute("session_fake", {
        tool_slug: "GMAIL_SEND_EMAIL",
        arguments: { body: marker },
        account: "ca_fake",
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });
});
