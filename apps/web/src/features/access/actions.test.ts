import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_OUT_ACTION_ID } from "@/actions/shell-actions";
import type { ActionEnvironment } from "@/actions/types";
import { accessActions } from "./actions.ts";
import { resetSharedSessionStoreForTests } from "./session-runtime.ts";
import { resetSignOutForTests } from "./sign-out.ts";
import { stubNavigation } from "./test-support.tsx";

const logout = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, getAccessApi: () => ({ logout, me: async () => undefined }) };
});

let location = stubNavigation("/now");

beforeEach(() => {
  logout.mockClear();
  resetSignOutForTests();
  resetSharedSessionStoreForTests();
  location = stubNavigation("/now");
});

afterEach(() => {
  location.restore();
});

const environment = {
  source: "menu",
  platform: "other",
  pane: null,
  services: {
    navigate: vi.fn(),
    assign: vi.fn(),
    announce: vi.fn(),
    route: null,
    shell: null,
  },
} as unknown as ActionEnvironment;

describe("the access feature's actions (§10.2)", () => {
  it("registers exactly the sign-out action the shell invokes", () => {
    expect(accessActions.map((action) => action.id)).toEqual([SIGN_OUT_ACTION_ID]);
    const [signOut] = accessActions;
    expect(signOut?.label).toBe("Sign out");
    expect(signOut?.availability(environment)).toEqual({ enabled: true });
  });

  it("signs out through the api and loads the email entry", async () => {
    const [signOut] = accessActions;
    await signOut?.run(environment);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(location.assign).toHaveBeenCalledWith("/signin");
  });

  it("fails loudly when the sign-out could not be completed", async () => {
    logout.mockRejectedValueOnce(new Error("offline"));
    const [signOut] = accessActions;
    await expect(signOut?.run(environment)).rejects.toThrow();
    expect(location.assign).not.toHaveBeenCalled();
  });
});
