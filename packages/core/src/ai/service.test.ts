import { decryptFieldText } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountKeyStore } from "../account/keys.ts";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { providerKeyContext } from "./fields.ts";
import { AiKeyRequiredError, AiKeyStore } from "./service.ts";

/**
 * Bring-your-own-key storage (§8.6).
 *
 * The environment is the documents one because it already builds a migrated database, a real key
 * provider and accounts with provisioned data keys — which is exactly what a test of encrypted
 * per-account storage needs.
 */

let env: DocumentsTestEnvironment;
let store: AiKeyStore;
let now = 1_758_000_000_000;

const defaults = {
  fast: { provider: "openai" as const, model: "gpt-5.6-luna" },
  smart: { provider: "openai" as const, model: "gpt-5.6-terra" },
};

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  now = 1_758_000_000_000;
  store = new AiKeyStore({ db: env.db, keys: env.keys, defaults, now: () => now });
});

afterEach(async () => {
  await env.close();
});

describe("storing a provider key", () => {
  it("never writes the key, or any part of it, in the clear", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-not-a-real-key-0123456789");
    const row = await env.db.first(
      sql(`SELECT * FROM ai_provider_keys WHERE owner_id = :owner`, { owner }),
    );
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("sk-not-a-real-key-0123456789");
    // Not even a recognisable tail: the schema deliberately keeps no hint column.
    expect(stored).not.toContain("6789");
    expect(String(row?.key_enc)).toMatch(/^sym1\./u);
  });

  it("round-trips through the account data key", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "anthropic", "sk-ant-round-trip-0123456789");
    const credential = await store.credentialFor(owner, "fast").catch(() => null);
    // Fast still points at the default provider, so ask for the one that was set.
    await store.setChoices(owner, { fast: { provider: "anthropic" } });
    expect(credential).toBeNull();
    expect((await store.credentialFor(owner, "fast")).apiKey).toBe("sk-ant-round-trip-0123456789");
  });

  it("binds the envelope to its provider, so a key cannot be read as another's", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-openai-0123456789abcd");
    const row = await env.db.first(
      sql(`SELECT key_enc FROM ai_provider_keys WHERE owner_id = :owner`, { owner }),
    );
    const key = await new AccountKeyStore({ db: env.db, keys: env.keys }).require(owner);
    // Opening the OpenAI envelope as the Anthropic row must fail rather than hand a live key to
    // the wrong company.
    expect(() =>
      decryptFieldText(key, providerKeyContext(owner, "anthropic"), String(row?.key_enc)),
    ).toThrow();
  });

  it("keeps one account's key away from another", async () => {
    const [a, b] = [await env.createUser(), await env.createUser()];
    await store.setKey(a, "openai", "sk-account-a-0123456789");
    await expect(store.credentialFor(b, "fast")).rejects.toBeInstanceOf(AiKeyRequiredError);
  });

  it("replaces a key and forgets that the old one worked", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-first-0123456789abcd");
    await store.markVerified(owner, "openai");
    expect((await store.settings(owner)).keys[0]?.verifiedAt).toBe(now);
    now += 1_000;
    await store.setKey(owner, "openai", "sk-second-0123456789abc");
    const after = (await store.settings(owner)).keys.find((key) => key.provider === "openai");
    expect(after?.verifiedAt).toBeNull();
    expect((await store.credentialFor(owner, "fast")).apiKey).toBe("sk-second-0123456789abc");
  });

  it("removes a key on request", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-removable-0123456789");
    await store.clearKey(owner, "openai");
    await expect(store.credentialFor(owner, "fast")).rejects.toBeInstanceOf(AiKeyRequiredError);
    expect(await store.usable(owner)).toBe(false);
  });
});

describe("confirming a key actually works", () => {
  it("records the first success and then stops writing", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-confirm-0123456789abc");
    // Unconfirmed until a provider has accepted it: shape validation proves nothing.
    expect((await store.credentialFor(owner, "fast")).verifiedAt).toBeNull();

    await store.markVerified(owner, "openai");
    expect((await store.credentialFor(owner, "fast")).verifiedAt).toBe(now);

    // A later success must not move the date: verified_at answers "has this ever worked", and
    // re-stamping it would spend a D1 write per model call.
    now += 60_000;
    await store.markVerified(owner, "openai");
    expect((await store.credentialFor(owner, "fast")).verifiedAt).toBe(now - 60_000);
  });

  it("asks the new key to prove itself when one is replaced", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-old-0123456789abcdef");
    await store.markVerified(owner, "openai");
    now += 1_000;
    await store.setKey(owner, "openai", "sk-new-0123456789abcdef");
    expect((await store.credentialFor(owner, "fast")).verifiedAt).toBeNull();
  });
});

describe("what the settings screen is told", () => {
  it("reports a key as configured without returning it", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-secret-value-0123456789");
    const settings = await store.settings(owner);
    expect(JSON.stringify(settings)).not.toContain("sk-secret-value-0123456789");
    const openai = settings.keys.find((key) => key.provider === "openai");
    expect(openai).toMatchObject({ configured: true, createdAt: now, verifiedAt: null });
    expect(settings.keys.find((key) => key.provider === "anthropic")?.configured).toBe(false);
  });

  it("starts with no key, both tiers on defaults, and nothing runnable", async () => {
    const owner = await env.createUser();
    const settings = await store.settings(owner);
    expect(settings.usable).toBe(false);
    expect(settings.tiers).toEqual([
      { tier: "fast", provider: "openai", model: "gpt-5.6-luna", ready: false, chosen: false },
      { tier: "smart", provider: "openai", model: "gpt-5.6-terra", ready: false, chosen: false },
    ]);
  });

  it("marks a tier ready once its provider has a key", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-ready-0123456789abcd");
    const settings = await store.settings(owner);
    expect(settings.usable).toBe(true);
    expect(settings.tiers.every((tier) => tier.ready)).toBe(true);
  });

  it("shows a tier pointing at a provider with no key as not ready", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-only-openai-0123456789");
    await store.setChoices(owner, { smart: { provider: "anthropic" } });
    const settings = await store.settings(owner);
    const smart = settings.tiers.find((tier) => tier.tier === "smart");
    expect(smart).toMatchObject({ provider: "anthropic", ready: false, chosen: true });
    // One tier still runs, so the account is usable even though the other is not.
    expect(settings.usable).toBe(true);
  });
});

describe("whether Simon can run at all", () => {
  it("agrees with the settings screen, key by key", async () => {
    const owner = await env.createUser();
    const agrees = async () => {
      const [gate, screen] = [await store.usable(owner), (await store.settings(owner)).usable];
      expect(gate).toBe(screen);
      return gate;
    };
    expect(await agrees()).toBe(false);
    await store.setKey(owner, "openai", "sk-openai-0123456789abcd");
    expect(await agrees()).toBe(true);
    // A key for a provider neither tier points at runs nothing, so the gate must not open.
    await store.setChoices(owner, {
      fast: { provider: "anthropic" },
      smart: { provider: "anthropic" },
    });
    expect(await agrees()).toBe(false);
    await store.setKey(owner, "anthropic", "sk-ant-0123456789abcdef");
    expect(await agrees()).toBe(true);
  });
});

describe("choosing what answers a tier", () => {
  it("lets the two tiers come from different providers", async () => {
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-openai-0123456789abcd");
    await store.setKey(owner, "anthropic", "sk-ant-0123456789abcdef");
    await store.setChoices(owner, {
      fast: { provider: "openai", model: "gpt-5.6-luna" },
      smart: { provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(await store.credentialFor(owner, "fast")).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "sk-openai-0123456789abcd",
    });
    expect(await store.credentialFor(owner, "smart")).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: "sk-ant-0123456789abcdef",
    });
  });

  it("leaves a tier alone when the change does not mention it", async () => {
    const owner = await env.createUser();
    await store.setChoices(owner, { fast: { model: "gpt-5.6" } });
    await store.setChoices(owner, { smart: { model: "claude-sonnet-5" } });
    const settings = await store.settings(owner);
    expect(settings.tiers.find((tier) => tier.tier === "fast")?.model).toBe("gpt-5.6");
    expect(settings.tiers.find((tier) => tier.tier === "smart")?.model).toBe("claude-sonnet-5");
  });

  it("returns a tier to the deployment default when it is cleared", async () => {
    const owner = await env.createUser();
    await store.setChoices(owner, { fast: { provider: "anthropic", model: "claude-sonnet-5" } });
    await store.setChoices(owner, { fast: { provider: null, model: null } });
    const fast = (await store.settings(owner)).tiers.find((tier) => tier.tier === "fast");
    expect(fast).toMatchObject({ provider: "openai", model: "gpt-5.6-luna", chosen: false });
  });

  it("accepts a model id the suggestions do not list", async () => {
    // The list is a convenience; gating on it would mean a new model could not be used until
    // Symplist shipped, which is the coupling bringing your own key removes.
    const owner = await env.createUser();
    await store.setKey(owner, "openai", "sk-future-0123456789abc");
    await store.setChoices(owner, { fast: { model: "gpt-9-not-released-yet" } });
    expect((await store.credentialFor(owner, "fast")).model).toBe("gpt-9-not-released-yet");
  });
});
