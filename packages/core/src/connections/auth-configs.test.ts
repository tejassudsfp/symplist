import { sql } from "@symplist/db";
import type { ConnectionLifecycleProvider, ToolkitSummary } from "@symplist/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { ComposioAuthConfigs } from "./auth-configs.ts";

let env: DocumentsTestEnvironment;
const toolkit: ToolkitSummary = { slug: "gmail", name: "Gmail", description: "", auth: "managed" };
function provider(): ConnectionLifecycleProvider {
  return {
    authConfigs: vi.fn(async () => ({ items: [], cursor: null })),
    createAuthConfig: vi.fn(async () => "ac_created"),
    link: vi.fn(),
    complete: vi.fn(),
    account: vi.fn(),
    accounts: vi.fn(),
    revoke: vi.fn(),
  };
}
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
});
afterEach(async () => env.close());

describe("serialized Composio auth configuration", () => {
  it("creates once, then returns the stored id without catalogue persistence", async () => {
    const api = provider();
    const configs = new ComposioAuthConfigs(env.db, api, () => env.clock);
    expect(await configs.findOrCreate(toolkit)).toBe("ac_created");
    expect(await configs.findOrCreate(toolkit)).toBe("ac_created");
    expect(api.createAuthConfig).toHaveBeenCalledTimes(1);
    expect(api.authConfigs).toHaveBeenCalledTimes(1);
    const row = await env.db.first(
      sql("SELECT * FROM composio_auth_configs WHERE toolkit = 'gmail'"),
    );
    expect(row).toMatchObject({ auth_config_id: "ac_created", lease_until: 0 });
    expect(JSON.stringify(row)).not.toContain("Gmail");
  });

  it("paginates past fifty and accepts only matching enabled managed configurations", async () => {
    const api = provider();
    vi.mocked(api.authConfigs)
      .mockResolvedValueOnce({
        items: Array.from({ length: 50 }, (_, i) => ({
          id: `wrong_${i}`,
          toolkit: "other",
          enabled: true,
          managed: true,
          scheme: "OAUTH2",
        })),
        cursor: "next",
      })
      .mockResolvedValueOnce({
        items: [{ id: "found", toolkit: "gmail", enabled: true, managed: true, scheme: "OAUTH2" }],
        cursor: null,
      });
    expect(await new ComposioAuthConfigs(env.db, api, () => env.clock).findOrCreate(toolkit)).toBe(
      "found",
    );
    expect(api.authConfigs).toHaveBeenLastCalledWith("gmail", "managed", "next");
    expect(api.createAuthConfig).not.toHaveBeenCalled();
  });

  it("a second process cannot create while the first holds a live lease", async () => {
    const api = provider();
    const other = provider();
    vi.mocked(api.createAuthConfig).mockImplementationOnce(async () => {
      await expect(
        new ComposioAuthConfigs(env.db, other, () => env.clock).findOrCreate(toolkit),
      ).rejects.toThrow("integration.unavailable");
      return "winner";
    });
    expect(await new ComposioAuthConfigs(env.db, api, () => env.clock).findOrCreate(toolkit)).toBe(
      "winner",
    );
    expect(other.createAuthConfig).not.toHaveBeenCalled();
  });

  it("fences an upstream response arriving after lease expiry", async () => {
    const api = provider();
    vi.mocked(api.createAuthConfig).mockImplementationOnce(async () => {
      env.clock += 60_001;
      return "late";
    });
    await expect(
      new ComposioAuthConfigs(env.db, api, () => env.clock).findOrCreate(toolkit),
    ).rejects.toThrow("integration.unavailable");
    expect(
      await env.db.first(
        sql("SELECT auth_config_id FROM composio_auth_configs WHERE toolkit = 'gmail'"),
      ),
    ).toEqual({ auth_config_id: null });
  });

  it("refuses repeated cursors and releases the lease", async () => {
    const api = provider();
    vi.mocked(api.authConfigs).mockResolvedValue({ items: [], cursor: "loop" });
    await expect(
      new ComposioAuthConfigs(env.db, api, () => env.clock).findOrCreate(toolkit),
    ).rejects.toThrow("integration.invalid_response");
    expect(api.createAuthConfig).not.toHaveBeenCalled();
    expect(
      await env.db.first(
        sql("SELECT lease_until FROM composio_auth_configs WHERE toolkit = 'gmail'"),
      ),
    ).toEqual({ lease_until: 0 });
  });

  it("never accepts a custom OAuth configuration in the API-key path", async () => {
    const api = provider();
    vi.mocked(api.authConfigs).mockResolvedValue({
      items: [{ id: "private", toolkit: "gmail", enabled: true, managed: false, scheme: "OAUTH2" }],
      cursor: null,
    });
    expect(
      await new ComposioAuthConfigs(env.db, api, () => env.clock).findOrCreate({
        ...toolkit,
        auth: "api_key",
      }),
    ).toBe("ac_created");
    expect(api.createAuthConfig).toHaveBeenCalledWith("gmail", "api_key");
  });
});
