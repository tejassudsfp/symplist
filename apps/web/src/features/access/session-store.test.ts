import { describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import { destinationFor, SessionStore } from "./session-store.ts";
import {
  admittedAccess,
  lockedAccess,
  mayaMe,
  pausedAccess,
  signedOutError,
} from "./test-support.tsx";

describe("the session store (§5.1)", () => {
  it("starts loading and keeps the identity after one read", async () => {
    const me = vi.fn(async () => mayaMe());
    const store = new SessionStore({ me });
    expect(store.getSnapshot().phase).toBe("loading");
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ phase: "signed_in", loadError: null });
    expect(store.getSnapshot().me?.user.email).toBe("maya@example.com");
  });

  it("shares one request between concurrent refreshes", async () => {
    const me = vi.fn(async () => mayaMe());
    const store = new SessionStore({ me });
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("starts only once", async () => {
    const me = vi.fn(async () => mayaMe());
    const store = new SessionStore({ me });
    store.start();
    store.start();
    await store.refresh();
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("reports a failed first read without guessing the session", async () => {
    const store = new SessionStore({
      me: async () => {
        throw new ApiNetworkError();
      },
    });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ phase: "loading", loadError: "network" });
  });

  it("keeps the known identity when a later read fails", async () => {
    let fail = false;
    const store = new SessionStore({
      me: async () => {
        if (fail) throw new ApiNetworkError();
        return mayaMe();
      },
    });
    await store.refresh();
    fail = true;
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ phase: "signed_in", loadError: "network" });
  });

  it("marks a session that ended while the page was open as expired", async () => {
    let ended = false;
    const store = new SessionStore({
      me: async () => {
        if (ended) throw signedOutError();
        return mayaMe();
      },
    });
    await store.refresh();
    ended = true;
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ phase: "signed_out", expired: true });
  });

  it("never calls a first 401 an expiry", async () => {
    const store = new SessionStore({
      me: async () => {
        throw signedOutError();
      },
    });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ phase: "signed_out", expired: false });
  });

  it("counts a change of access as a revision, and an identical read as none", async () => {
    const store = new SessionStore({ me: async () => mayaMe() });
    await store.refresh();
    const before = store.getSnapshot().accessRevision;
    store.setMe(mayaMe());
    expect(store.getSnapshot().accessRevision).toBe(before);
    store.setMe(mayaMe({ access: pausedAccess }));
    expect(store.getSnapshot().accessRevision).toBe(before + 1);
  });

  it("notifies its subscribers", async () => {
    const store = new SessionStore({ me: async () => mayaMe() });
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    await store.refresh();
    expect(listener).toHaveBeenCalled();
    stop();
    listener.mockClear();
    store.setMe(mayaMe({ access: lockedAccess }));
    expect(listener).not.toHaveBeenCalled();
  });

  it("reports how stale the identity is", async () => {
    let now = 1_000;
    const store = new SessionStore({ me: async () => mayaMe() }, () => now);
    expect(store.ageMs()).toBe(Number.POSITIVE_INFINITY);
    await store.refresh();
    now = 61_000;
    expect(store.ageMs()).toBe(60_000);
  });
});

describe("the destination of a fixed session", () => {
  it("mirrors the api's rules", () => {
    expect(destinationFor(admittedAccess)).toBe("app");
    expect(destinationFor({ ...admittedAccess, onboardingStep: "name" })).toBe("onboarding");
    expect(destinationFor(lockedAccess)).toBe("beta_gate");
    expect(destinationFor(pausedAccess)).toBe("paused");
    expect(destinationFor({ ...admittedAccess, suspendedAt: 1 })).toBe("paused");
    expect(destinationFor({ ...admittedAccess, emailVerifiedAt: null })).toBe("beta_gate");
    // A deployment without the beta gate admits every verified account (note 04, self-hosting).
    expect(destinationFor(lockedAccess, false)).toBe("onboarding");
  });
});
