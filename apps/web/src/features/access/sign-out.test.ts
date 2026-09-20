import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import { APPEARANCE_COOKIE } from "@/theme/appearance";
import { writeAppearanceCookie } from "@/theme/appearance-client";
import {
  beginAccountDeletionExit,
  clearBrowserSessionState,
  getSignOutState,
  registerSignOutCleanup,
  resetSignOutForTests,
  signOut,
} from "./sign-out.ts";
import { signedOutError, stubNavigation } from "./test-support.tsx";

let location = stubNavigation("/now");

beforeEach(() => {
  resetSignOutForTests();
  window.sessionStorage.clear();
  window.localStorage.clear();
  location = stubNavigation("/now");
});

afterEach(() => {
  location.restore();
});

function dependencies(overrides: Partial<Parameters<typeof signOut>[0]> = {}) {
  return {
    api: { logout: vi.fn(async () => undefined) },
    clearCsrfToken: vi.fn(),
    markSignedOut: vi.fn(),
    assign: vi.fn(),
    ...overrides,
  };
}

describe("signing out (§5.1, §15)", () => {
  it("ends the session, clears browser state and loads the email entry as a new document", async () => {
    writeAppearanceCookie({ themeId: "paper", mode: "dark", accent: "rose" });
    expect(document.cookie).toContain(APPEARANCE_COOKIE);
    window.sessionStorage.setItem("symplist.access.signin", "{}");
    window.localStorage.setItem("ph_phc_test_posthog", "{}");
    const deps = dependencies();
    const outcome = await signOut(deps);
    expect(outcome).toBe("signed_out");
    expect(deps.api.logout).toHaveBeenCalledTimes(1);
    expect(deps.clearCsrfToken).toHaveBeenCalled();
    expect(deps.markSignedOut).toHaveBeenCalled();
    expect(deps.assign).toHaveBeenCalledWith("/signin");
    expect(document.cookie).not.toContain(APPEARANCE_COOKIE);
    expect(window.sessionStorage.getItem("symplist.access.signin")).toBeNull();
    // The analytics identity never carries into the next account on this device (§15).
    expect(window.localStorage.getItem("ph_phc_test_posthog")).toBeNull();
  });

  it("runs the cleanups other features registered", async () => {
    const cleanup = vi.fn();
    const unregister = registerSignOutCleanup(cleanup);
    await signOut(dependencies());
    expect(cleanup).toHaveBeenCalledTimes(1);
    unregister();
    resetSignOutForTests();
    await signOut(dependencies());
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("never lets one feature's cleanup keep the person signed in", async () => {
    registerSignOutCleanup(() => {
      throw new Error("boom");
    });
    const deps = dependencies();
    expect(await signOut(deps)).toBe("signed_out");
    expect(deps.assign).toHaveBeenCalled();
  });

  it("keeps the person signed in when the api could not be reached", async () => {
    const deps = dependencies({
      api: {
        logout: vi.fn(async () => {
          throw new ApiNetworkError();
        }),
      },
    });
    expect(await signOut(deps)).toBe("failed");
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.markSignedOut).not.toHaveBeenCalled();
    expect(getSignOutState()).toEqual({ kind: "failed", reason: "network" });
  });

  it("counts a session that had already ended as signed out", async () => {
    const deps = dependencies({
      api: {
        logout: vi.fn(async () => {
          throw signedOutError();
        }),
      },
    });
    expect(await signOut(deps)).toBe("signed_out");
    expect(deps.assign).toHaveBeenCalledWith("/signin");
  });

  it("refuses a second sign-out while one is running", async () => {
    let release = (): void => undefined;
    const deps = dependencies({
      api: {
        logout: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              release = () => resolve();
            }),
        ),
      },
    });
    const first = signOut(deps);
    expect(await signOut(deps)).toBe("in_progress");
    release();
    expect(await first).toBe("signed_out");
  });

  it("reports the state while leaving after an accepted deletion", () => {
    beginAccountDeletionExit();
    expect(getSignOutState()).toEqual({ kind: "signing_out", reason: "account_deleted" });
  });

  it("clears browser state without ending a session that is already gone", async () => {
    window.sessionStorage.setItem("symplist.access.interrupted", "1");
    const clearCsrfToken = vi.fn();
    await clearBrowserSessionState({ clearCsrfToken });
    expect(clearCsrfToken).toHaveBeenCalled();
    expect(window.sessionStorage.getItem("symplist.access.interrupted")).toBeNull();
  });
});
