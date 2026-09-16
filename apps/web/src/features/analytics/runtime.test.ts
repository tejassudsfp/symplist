import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyticsSnapshot,
  chooseAnalytics,
  loadAnalytics,
  resetAnalytics,
  track,
} from "./runtime.ts";

const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ getApiClient: () => client }));
const settings = (state: "unset" | "granted" | "denied", enabled = true) => ({
  enabled,
  consent: { state, decidedAt: state === "unset" ? null : 1234 },
});
beforeEach(() => {
  resetAnalytics();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/now?utm_source=PRIVATE-CAMPAIGN");
  client.get.mockResolvedValue(settings("unset"));
  client.put.mockImplementation(async (_path, options) => settings(options.body.state));
  client.post.mockResolvedValue(undefined);
});
afterEach(() => resetAnalytics());
describe("private first-party analytics relay", () => {
  it("does not touch browser storage or send analytics before stored consent", async () => {
    const store = vi.spyOn(Storage.prototype, "setItem");
    track("quick_chat_started", { entry: "button" });
    await loadAnalytics("owner");
    track("quick_chat_started", { entry: "button" });
    expect(client.post).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    store.mockRestore();
  });
  it("sends only an allowlisted enum payload with a random event id, not identity or browsing context", async () => {
    await loadAnalytics("owner");
    await chooseAnalytics("granted");
    track("quick_chat_started", { entry: "button" });
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/v1/analytics/events", {
      body: {
        event: "quick_chat_started",
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        properties: { entry: "button" },
      },
    });
    const payload = JSON.stringify(client.post.mock.calls);
    for (const forbidden of [
      "owner",
      "analyticsId",
      "analytics_id",
      "distinct_id",
      "PRIVATE-CAMPAIGN",
      "referrer",
      "url",
      "utm_",
    ])
      expect(payload).not.toContain(forbidden);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
  it("stops sends immediately during withdrawal and never replays dropped events", async () => {
    client.get.mockResolvedValue(settings("granted"));
    await loadAnalytics("owner");
    let finish: ((value: ReturnType<typeof settings>) => void) | undefined;
    client.put.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const withdrawal = chooseAnalytics("denied");
    track("quick_chat_started", { entry: "button" });
    expect(client.post).not.toHaveBeenCalled();
    finish?.(settings("denied"));
    await withdrawal;
    track("quick_chat_started", { entry: "button" });
    expect(client.post).not.toHaveBeenCalled();
    expect(analyticsSnapshot().settings?.consent.state).toBe("denied");
  });
  it("fails closed if withdrawal fails and ignores a late previous-user response", async () => {
    client.get.mockResolvedValue(settings("granted"));
    await loadAnalytics("owner");
    client.put.mockRejectedValue(new Error("offline"));
    await chooseAnalytics("denied");
    expect(analyticsSnapshot().error).toBe(true);
    track("quick_chat_started", { entry: "button" });
    expect(client.post).not.toHaveBeenCalled();
    resetAnalytics();
    let finish: ((value: ReturnType<typeof settings>) => void) | undefined;
    client.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stale = loadAnalytics("old-owner");
    resetAnalytics();
    finish?.(settings("granted"));
    await stale;
    expect(analyticsSnapshot().ownerId).toBeNull();
    expect(analyticsSnapshot().settings).toBeNull();
  });
  it.each(["/vault", "/signin", "/artifact/example", "/oauth/consent"])(
    "refuses excluded path %s even after consent",
    async (pathname) => {
      client.get.mockResolvedValue(settings("granted"));
      await loadAnalytics("owner");
      window.history.replaceState({}, "", pathname);
      track("quick_chat_started", { entry: "button" });
      expect(client.post).not.toHaveBeenCalled();
    },
  );
  it("rejects unknown properties and treats provider outages as non-blocking", async () => {
    client.get.mockResolvedValue(settings("granted"));
    await loadAnalytics("owner");
    track("quick_chat_started", { entry: "button", ...{ title: "PRIVATE" } });
    expect(client.post).not.toHaveBeenCalled();
    client.post.mockRejectedValue(new Error("offline"));
    expect(() => track("quick_chat_started", { entry: "button" })).not.toThrow();
    await Promise.resolve();
  });
  it("deployment disablement and sign-out prevent captures", async () => {
    client.get.mockResolvedValue(settings("granted", false));
    await loadAnalytics("owner");
    track("quick_chat_started", { entry: "button" });
    expect(client.post).not.toHaveBeenCalled();
    resetAnalytics();
    track("quick_chat_started", { entry: "button" });
    expect(client.post).not.toHaveBeenCalled();
  });
});
