import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { PreferencesStore, samePreferenceData } from "./preferences-store.ts";
import { FakeWorkspaceApi } from "./test-support.tsx";

function store(api = new FakeWorkspaceApi()) {
  return { api, preferences: new PreferencesStore(api, { debounceMs: 0 }) };
}

describe("PreferencesStore", () => {
  it("reloads a request that settled while disposed instead of staying loading", async () => {
    const { preferences, api } = store();
    const pending = preferences.load();
    preferences.dispose();
    await pending;
    expect(preferences.status).toBe("loading");
    preferences.reopen();
    expect(preferences.status).toBe("idle");
    const listener = vi.fn();
    preferences.subscribe(listener);
    preferences.ensureLoaded();
    await vi.waitFor(() => expect(preferences.status).toBe("ready"));
    expect(listener).toHaveBeenCalled();
    expect(api.calls.filter((call) => call.method === "getPreferences")).toHaveLength(2);
  });

  it("accepts its pending load after immediate cleanup and reopen", async () => {
    const { preferences, api } = store();
    api.setPreference("appearance", { themeId: "paper", mode: "dark", accent: "violet" }, 3);
    const pending = preferences.load();
    preferences.dispose();
    preferences.reopen();
    const listener = vi.fn();
    preferences.subscribe(listener);
    await pending;
    expect(preferences.status).toBe("ready");
    expect(preferences.get("appearance").themeId).toBe("paper");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("resumes a debounced save cancelled by cleanup", async () => {
    const { preferences, api } = store();
    await preferences.load();
    preferences.set("appearance", { themeId: "paper", mode: "dark", accent: "violet" });
    preferences.dispose();
    preferences.reopen();
    await vi.waitFor(() => expect(preferences.snapshot("appearance").state).toBe("saved"));
    expect(api.storedPreference("appearance").themeId).toBe("paper");
    expect(api.calls.filter((call) => call.method === "putPreference")).toHaveLength(1);
  });

  it("reconciles a save that committed while disposed without losing the preview", async () => {
    const { preferences, api } = store();
    await preferences.load();
    preferences.set(
      "appearance",
      { themeId: "paper", mode: "dark", accent: "violet" },
      { immediate: true },
    );
    preferences.dispose();
    await vi.waitFor(() => expect(api.storedPreference("appearance").themeId).toBe("paper"));
    preferences.reopen();
    await vi.waitFor(() => expect(preferences.snapshot("appearance").state).toBe("saved"));
    expect(preferences.snapshot("appearance").saved).toEqual(preferences.get("appearance"));
    expect(preferences.snapshot("appearance").version).toBe(1);
  });

  it("loads every group once and reports the defaults until something is saved", async () => {
    const { preferences, api } = store();
    preferences.ensureLoaded();
    preferences.ensureLoaded();
    await vi.waitFor(() => expect(preferences.status).toBe("ready"));
    expect(preferences.get("appearance")).toEqual({
      themeId: "studio",
      mode: "system",
      accent: "blue",
    });
    expect(api.calls.filter((call) => call.method === "getPreferences")).toHaveLength(1);
  });

  it("explains a failed load and loads again on retry", async () => {
    const { preferences, api } = store();
    api.fail("getPreferences");
    await preferences.load();
    expect(preferences.status).toBe("error");
    expect(preferences.failure?.kind).toBe("busy");
    await preferences.load();
    expect(preferences.status).toBe("ready");
  });

  it("applies a change at once and saves it to the account", async () => {
    const { preferences, api } = store();
    await preferences.load();
    preferences.set("appearance", { themeId: "paper", mode: "dark", accent: "violet" });
    expect(preferences.get("appearance").themeId).toBe("paper");
    expect(preferences.snapshot("appearance").state).toBe("saving");
    await vi.waitFor(() => expect(preferences.snapshot("appearance").state).toBe("saved"));
    expect(api.storedPreference("appearance")).toEqual({
      themeId: "paper",
      mode: "dark",
      accent: "violet",
    });
  });

  it("keeps the newest choice when changes arrive faster than the saves", async () => {
    const { preferences, api } = store();
    await preferences.load();
    preferences.set("appearance", { themeId: "paper", mode: "system", accent: "blue" });
    preferences.set("appearance", { themeId: "pebble", mode: "system", accent: "blue" });
    preferences.set("appearance", { themeId: "tide", mode: "system", accent: "green" });
    await vi.waitFor(() => expect(preferences.snapshot("appearance").state).toBe("saved"));
    expect(preferences.get("appearance")).toEqual({
      themeId: "tide",
      mode: "system",
      accent: "green",
    });
    expect(api.storedPreference("appearance")).toEqual(preferences.get("appearance"));
  });

  it("replans a save against a version another device wrote first", async () => {
    const { preferences, api } = store();
    await preferences.load();
    api.setPreference("appearance", { themeId: "meadow", mode: "light", accent: "teal" }, 7);
    preferences.set("appearance", { themeId: "postcard", mode: "dark", accent: "rose" });
    await vi.waitFor(() => expect(preferences.snapshot("appearance").state).toBe("saved"));
    // The person's own choice wins, saved on top of the other device's version.
    expect(api.storedPreference("appearance")).toEqual({
      themeId: "postcard",
      mode: "dark",
      accent: "rose",
    });
    expect(preferences.snapshot("appearance").version).toBe(8);
  });

  it("says the change is only previewing here when it cannot be saved, and retries", async () => {
    const { preferences, api } = store();
    await preferences.load();
    api.fail("putPreference", undefined, true);
    preferences.set("keyboard", {
      overrides: { "workspace.rename_task": "e" },
      singleKeyShortcuts: true,
    });
    await vi.waitFor(() => expect(preferences.snapshot("keyboard").state).toBe("previewing"));
    expect(preferences.snapshot("keyboard").failure?.kind).toBe("busy");
    // The preview is still what this browser uses.
    expect(preferences.get("keyboard").overrides).toEqual({ "workspace.rename_task": "e" });

    api.clearFailure("putPreference");
    preferences.retry("keyboard");
    await vi.waitFor(() => expect(preferences.snapshot("keyboard").state).toBe("saved"));
    expect(api.storedPreference("keyboard").overrides).toEqual({ "workspace.rename_task": "e" });
  });

  it("follows a group another device changed", async () => {
    const { preferences, api } = store();
    await preferences.load();
    api.setPreference(
      "panels",
      {
        inboxCollapsed: true,
        chatCollapsed: false,
        inboxWidth: 320,
        chatWidth: null,
      },
      4,
    );
    preferences.noteChanged("panels", 4);
    await vi.waitFor(() => expect(preferences.get("panels").inboxCollapsed).toBe(true));
    expect(preferences.get("panels").inboxWidth).toBe(320);
  });

  it("reads a stored group of an older shape as that group's defaults", async () => {
    const api = new FakeWorkspaceApi();
    api.setPreference("appearance", { themeId: "paper", brightness: "dark" }, 3);
    const { preferences } = store(api);
    await preferences.load();
    expect(preferences.get("appearance")).toEqual({
      themeId: "studio",
      mode: "system",
      accent: "blue",
    });
    expect(preferences.snapshot("appearance").version).toBe(3);
  });

  it("never saves a change that ends where it started", async () => {
    const { preferences, api } = store();
    await preferences.load();
    preferences.set("chat", { enterToSend: true, defaultTier: null });
    preferences.set("chat", { enterToSend: false, defaultTier: null });
    await vi.waitFor(() => expect(preferences.snapshot("chat").state).toBe("saved"));
    expect(api.calls.filter((call) => call.method === "putPreference")).toHaveLength(0);
  });

  it("compares preference values by content", () => {
    expect(samePreferenceData({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(samePreferenceData({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("accepts the account's version when a conflict already holds the same choice", async () => {
    const { preferences, api } = store();
    await preferences.load();
    api.fail(
      "putPreference",
      new ApiError({
        status: 409,
        code: "preferences.conflict",
        message: "Saved elsewhere",
        requestId: "req-test",
        details: {
          group: "privacy",
          version: 9,
          data: { includeChatInSearch: true },
          updatedAt: null,
          clientSeq: 1,
        },
      }),
    );
    preferences.set("privacy", { includeChatInSearch: true });
    await vi.waitFor(() => expect(preferences.snapshot("privacy").state).toBe("saved"));
    // The other device already saved exactly this, so nothing is written again.
    expect(preferences.snapshot("privacy").version).toBe(9);
    expect(api.calls.filter((call) => call.method === "putPreference")).toHaveLength(1);
  });
});
