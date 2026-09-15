import { describe, expect, it } from "vitest";
import {
  createBrowserAnalytics,
  isExcludedAnalyticsPath,
  type PostHogBrowserClient,
  removePostHogStorageKeys,
} from "./browser.ts";

type Call = readonly [method: string, ...args: unknown[]];

function fakePostHog(options: { failCapture?: boolean } = {}) {
  const calls: Call[] = [];
  const client: PostHogBrowserClient = {
    __loaded: false,
    init(token, config) {
      calls.push(["init", token, config]);
      client.__loaded = true;
    },
    opt_in_capturing(opts) {
      calls.push(["opt_in_capturing", opts]);
    },
    opt_out_capturing() {
      calls.push(["opt_out_capturing"]);
    },
    identify(id) {
      calls.push(["identify", id]);
    },
    capture(name, properties) {
      if (options.failCapture) throw new Error("capture failed");
      calls.push(["capture", name, properties]);
    },
    reset() {
      calls.push(["reset"]);
    },
  };
  return { client, calls };
}

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const search = {
  surface: "command_palette",
  include_archive: false,
  include_chat: true,
  result_count: "6-20",
} as const;

function setup(
  overrides: {
    enabled?: boolean;
    projectKey?: string | undefined;
    path?: string;
    failCapture?: boolean;
    failLoad?: boolean;
  } = {},
) {
  const { client, calls } = fakePostHog({ failCapture: overrides.failCapture ?? false });
  let path = overrides.path ?? "/now";
  let loads = 0;
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const analytics = createBrowserAnalytics({
    enabled: overrides.enabled ?? true,
    projectKey: "projectKey" in overrides ? overrides.projectKey : "phc_fictional_unit_key",
    loadPostHog: async () => {
      loads += 1;
      if (overrides.failLoad) throw new Error("chunk load failed");
      return client;
    },
    currentPath: () => path,
    storages: () => [session, local],
  });
  return {
    analytics,
    calls,
    session,
    local,
    loads: () => loads,
    navigate: (next: string) => {
      path = next;
    },
  };
}

describe("excluded routes (§15)", () => {
  it.each([
    "/signin",
    "/signin/verify",
    "/signin/create?next=/now",
    "/access",
    "/access/paused",
    "/vault",
    "/vault/items/1",
    "/oauth/consent",
    "/artifact/abc",
    "/connections/callback",
    "/connections/callback?status=success&connected_account_id=ca_1",
  ])("excludes %s", (path) => {
    expect(isExcludedAnalyticsPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/now",
    "/now/1",
    "/settings/account",
    "/settings/connections",
    "/vaulted",
    "/signing",
    "/welcome",
  ])("does not exclude %s", (path) => {
    expect(isExcludedAnalyticsPath(path)).toBe(false);
  });
});

describe("browser analytics", () => {
  it("loads, initializes, opts in without an $opt_in event, and identifies only after consent", async () => {
    const { analytics, calls, loads } = setup();
    expect(analytics.track("search_used", search)).toEqual({
      status: "refused",
      reason: "consent_not_granted",
    });
    expect(loads()).toBe(0);

    expect(await analytics.applyConsent({ consent: "granted", analyticsId: "a1" })).toEqual({
      status: "active",
    });
    expect(loads()).toBe(1);
    expect(calls.map(([method]) => method)).toEqual(["init", "opt_in_capturing", "identify"]);
    expect(calls[0]?.[1]).toBe("phc_fictional_unit_key");
    expect(calls[1]).toEqual(["opt_in_capturing", { captureEventName: false }]);
    expect(calls[2]).toEqual(["identify", "a1"]);

    expect(analytics.track("search_used", search)).toEqual({ status: "sent" });
    expect(calls.at(-1)).toEqual(["capture", "search_used", { ...search, event_version: 1 }]);
  });

  it("does nothing at all when analytics is disabled or unconfigured", async () => {
    for (const overrides of [{ enabled: false }, { projectKey: undefined }, { projectKey: "" }]) {
      const { analytics, calls, loads } = setup(overrides);
      expect(await analytics.applyConsent({ consent: "granted", analyticsId: "a1" })).toEqual({
        status: "inactive",
        reason: "disabled",
      });
      expect(analytics.track("search_used", search)).toEqual({
        status: "refused",
        reason: "disabled",
      });
      expect(loads()).toBe(0);
      expect(calls).toEqual([]);
    }
  });

  it("never loads on an excluded route and refuses to track while one is active", async () => {
    const excluded = setup({ path: "/vault/unlock" });
    expect(
      await excluded.analytics.applyConsent({ consent: "granted", analyticsId: "a1" }),
    ).toEqual({
      status: "inactive",
      reason: "excluded_route",
    });
    expect(excluded.loads()).toBe(0);

    const active = setup();
    await active.analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    active.navigate("/signin/verify");
    expect(active.analytics.track("search_used", search)).toEqual({
      status: "refused",
      reason: "excluded_route",
    });
    expect(active.calls.filter(([method]) => method === "capture")).toEqual([]);
  });

  it("needs an analytics id before loading", async () => {
    const { analytics, loads } = setup();
    expect(await analytics.applyConsent({ consent: "granted", analyticsId: null })).toEqual({
      status: "inactive",
      reason: "missing_identity",
    });
    expect(loads()).toBe(0);
  });

  it("rejects unknown events, server-owned events and free text", async () => {
    const { analytics, calls } = setup();
    await analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    const before = calls.length;

    const untyped = analytics.track as (name: string, properties: unknown) => unknown;
    expect(untyped("page_viewed", {})).toEqual({ status: "refused", reason: "unknown_event" });
    expect(
      untyped("task_created", { source: "user", collection: "now", is_subtask: false }),
    ).toEqual({
      status: "refused",
      reason: "wrong_owner",
    });
    expect(untyped("search_used", { ...search, query: "refresh my portfolio" })).toEqual({
      status: "refused",
      reason: "invalid_properties",
    });
    expect(untyped("quick_chat_started", { entry: "Plan a quiet weekend" })).toEqual({
      status: "refused",
      reason: "invalid_properties",
    });
    expect(calls.length).toBe(before);
  });

  it("withdrawal opts out, resets, removes ph_* keys and refuses later events", async () => {
    const { analytics, calls, session, local } = setup();
    await analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    session.setItem("ph_phc_fictional_unit_key_window_id", "w");
    session.setItem("ph_phc_fictional_unit_key_posthog", "{}");
    local.setItem("ph_phc_fictional_unit_key_posthog", "{}");
    local.setItem("__ph_opt_in_out_phc_fictional_unit_key", "1");
    local.setItem("sym_appearance_draft", "keep");

    await analytics.withdraw();

    expect(calls.slice(-2).map(([method]) => method)).toEqual(["opt_out_capturing", "reset"]);
    expect(session.length).toBe(0);
    expect(local.length).toBe(1);
    expect(local.getItem("sym_appearance_draft")).toBe("keep");
    expect(analytics.track("search_used", search)).toEqual({
      status: "refused",
      reason: "consent_not_granted",
    });
  });

  it("stored denial withdraws a loaded client; unset after sign-out only resets", async () => {
    const denied = setup();
    await denied.analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    await denied.analytics.applyConsent({ consent: "denied", analyticsId: "a1" });
    expect(denied.calls.slice(-2).map(([method]) => method)).toEqual([
      "opt_out_capturing",
      "reset",
    ]);

    const unset = setup();
    await unset.analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    await unset.analytics.applyConsent({ consent: "unset", analyticsId: "a2" });
    expect(unset.calls.at(-1)?.[0]).toBe("reset");
    expect(unset.calls.some(([method]) => method === "opt_out_capturing")).toBe(false);
  });

  it("a stored denial clears PostHog state left on the device without ever loading the SDK", async () => {
    const { analytics, calls, session, local, loads } = setup();
    local.setItem("ph_phc_fictional_unit_key_posthog", '{"distinct_id":"previous"}');
    local.setItem("__ph_opt_in_out_phc_fictional_unit_key", "1");
    session.setItem("ph_phc_fictional_unit_key_window_id", "w");
    local.setItem("sym_hint_draft", "keep");

    expect(await analytics.applyConsent({ consent: "denied", analyticsId: "a1" })).toEqual({
      status: "inactive",
      reason: "consent_not_granted",
    });

    expect(loads()).toBe(0);
    expect(calls).toEqual([]);
    expect(session.length).toBe(0);
    expect([local.length, local.getItem("sym_hint_draft")]).toEqual([1, "keep"]);
  });

  it("logout clears the stored identity even when this page never loaded the SDK", async () => {
    const { analytics, calls, local, loads } = setup({ path: "/access" });
    local.setItem("ph_phc_fictional_unit_key_posthog", '{"distinct_id":"a1"}');
    await analytics.logout();
    expect(loads()).toBe(0);
    expect(calls).toEqual([]);
    expect(local.length).toBe(0);
  });

  it("resets identity before identifying a different account on the same page", async () => {
    const { analytics, calls } = setup();
    await analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    await analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    expect(calls.filter(([method]) => method === "reset")).toEqual([]);
    await analytics.applyConsent({ consent: "granted", analyticsId: "a2" });
    expect(calls.slice(-3)).toEqual([
      ["reset"],
      ["opt_in_capturing", { captureEventName: false }],
      ["identify", "a2"],
    ]);
  });

  it("logout resets without opting in again, and consent re-applies after the next sign-in", async () => {
    const { analytics, calls, local } = setup();
    await analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    local.setItem("ph_phc_fictional_unit_key_posthog", "{}");
    await analytics.logout();
    expect(calls.at(-1)).toEqual(["reset"]);
    expect(calls.some(([method]) => method === "opt_out_capturing")).toBe(false);
    expect(local.length).toBe(0);
    expect(analytics.track("search_used", search)).toEqual({
      status: "refused",
      reason: "consent_not_granted",
    });

    await analytics.applyConsent({ consent: "granted", analyticsId: "a2" });
    const inits = calls.filter(([method]) => method === "init");
    expect(inits).toHaveLength(1);
    expect(calls.slice(-2)).toEqual([
      ["opt_in_capturing", { captureEventName: false }],
      ["identify", "a2"],
    ]);
  });

  it("applies consent changes in order even when they overlap", async () => {
    const { analytics, calls } = setup();
    const granted = analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    const withdrawn = analytics.withdraw();
    await Promise.all([granted, withdrawn]);
    expect(calls.map(([method]) => method)).toEqual([
      "init",
      "opt_in_capturing",
      "identify",
      "opt_out_capturing",
      "reset",
    ]);
    expect(analytics.track("search_used", search).status).toBe("refused");
  });

  it("never throws when the SDK fails to load or capture", async () => {
    const failingLoad = setup({ failLoad: true });
    expect(
      await failingLoad.analytics.applyConsent({ consent: "granted", analyticsId: "a1" }),
    ).toEqual({
      status: "inactive",
      reason: "load_failed",
    });
    expect(failingLoad.analytics.track("search_used", search)).toEqual({
      status: "refused",
      reason: "not_loaded",
    });

    const failingCapture = setup({ failCapture: true });
    await failingCapture.analytics.applyConsent({ consent: "granted", analyticsId: "a1" });
    expect(failingCapture.analytics.track("search_used", search)).toEqual({
      status: "refused",
      reason: "client_error",
    });
  });
});

describe("removePostHogStorageKeys", () => {
  it("removes only PostHog keys", () => {
    const storage = new MemoryStorage();
    storage.setItem("ph_a", "1");
    storage.setItem("__ph_opt_in_out_b", "1");
    storage.setItem("phone", "keep");
    storage.setItem("sym_hint", "keep");
    removePostHogStorageKeys(storage);
    expect([storage.key(0), storage.key(1), storage.length]).toEqual(["phone", "sym_hint", 2]);
  });
});
