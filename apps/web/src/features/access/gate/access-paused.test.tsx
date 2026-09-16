import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import { SessionStore } from "../session-store.ts";
import {
  admittedAccess,
  createFakeAccessApi,
  mayaMe,
  pausedAccess,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { AccessPaused } from "./access-paused.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/access/paused",
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

let location = stubNavigation("/access/paused");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  window.sessionStorage.clear();
  location = stubNavigation("/access/paused");
});

afterEach(() => {
  location.restore();
});

describe("paused access (access_revoked.md)", () => {
  it("explains the pause without a code field and without punitive wording", async () => {
    renderAccess(<AccessPaused />, { me: mayaMe({ access: pausedAccess }) });
    expect(
      await screen.findByRole("heading", { name: "Access is currently paused" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/An administrator paused this account's beta access/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Invite code")).not.toBeInTheDocument();
    expect(screen.getByText(/An invite code can't reopen a paused account/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "manage or delete your account" })).toHaveAttribute(
      "href",
      "/access/account",
    );
    // A suspended or relocked account never sees a support address that was never configured.
    expect(screen.queryByText(/support@/)).not.toBeInTheDocument();
  });

  it("uses suspension wording for a suspended account", async () => {
    renderAccess(<AccessPaused />, {
      me: mayaMe({ access: { ...pausedAccess, betaState: "unlocked", suspendedAt: Date.now() } }),
    });
    expect(await screen.findByText(/This account is suspended/)).toBeInTheDocument();
  });

  it("explains an interruption and takes focus when access changed during work", async () => {
    window.sessionStorage.setItem("symplist.access.interrupted", "1");
    renderAccess(<AccessPaused />, { me: mayaMe({ access: pausedAccess }) });
    const heading = await screen.findByRole("heading", { name: "Access is currently paused" });
    expect(await screen.findByText("Your session was interrupted")).toBeInTheDocument();
    expect(
      screen.getByText(/Work in progress was stopped where that was possible/),
    ).toBeInTheDocument();
    await waitFor(() => expect(heading).toHaveFocus());
    // The mark is consumed, so a later visit does not repeat it.
    expect(window.sessionStorage.getItem("symplist.access.interrupted")).toBeNull();
  });

  it("says when a check found no change", async () => {
    const user = userEvent.setup();
    renderAccess(<AccessPaused />, { me: mayaMe({ access: pausedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Check access" }));
    expect(
      await screen.findByText("Access is still paused. Nothing has changed yet."),
    ).toBeInTheDocument();
  });

  it("opens the app again when access was restored", async () => {
    const user = userEvent.setup();
    let identity = mayaMe({ access: pausedAccess });
    const store = new SessionStore({ me: async () => identity });
    store.setMe(identity);
    renderAccess(<AccessPaused />, { store });
    identity = mayaMe({ access: admittedAccess });
    await user.click(await screen.findByRole("button", { name: "Check access" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/now"));
  });

  it("reports a failed access check", async () => {
    const user = userEvent.setup();
    const store = new SessionStore({
      me: async () => {
        throw new ApiNetworkError();
      },
    });
    store.setMe(mayaMe({ access: pausedAccess }));
    renderAccess(<AccessPaused />, { store });
    await user.click(await screen.findByRole("button", { name: "Check access" }));
    expect(await screen.findByText("We couldn't check your access")).toBeInTheDocument();
  });

  it("signs out through the session controls", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ logout: vi.fn(async () => undefined) });
    renderAccess(<AccessPaused />, { api, me: mayaMe({ access: pausedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(location.assign).toHaveBeenCalledWith("/signin"));
  });
});
