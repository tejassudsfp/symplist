import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import { resetSignOutForTests } from "../sign-out.ts";
import {
  admittedAccess,
  createFakeAccessApi,
  mayaMe,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { AccountSettings } from "./account-settings.tsx";
import { SettingsFrame } from "./settings-frame.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/settings/account",
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

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

/** The Account section inside the Settings shell its route layout provides. */
function accountScreen() {
  return (
    <SettingsFrame>
      <AccountSettings />
    </SettingsFrame>
  );
}

let location = stubNavigation("/settings/account");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  resetSignOutForTests();
  location = stubNavigation("/settings/account");
});

afterEach(() => {
  location.restore();
});

describe("Settings → Account (settings_account.md)", () => {
  it("shows the settings sections, the name, the read-only email and the access indicator", async () => {
    renderAccess(accountScreen(), { me: mayaMe() });
    expect(await screen.findByRole("heading", { level: 1, name: "Account" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Account" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "← Back to workspace" })).toHaveAttribute(
      "href",
      "/now",
    );
    // No billing section in the beta.
    expect(within(nav).queryByRole("link", { name: /billing/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Maya Rao");
    expect(screen.getByText("maya@example.com")).toBeInTheDocument();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
    expect(screen.getByText(/Your email address is fixed for this release/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it("leaves a named slot for the analytics feature's Privacy section", async () => {
    const { container } = renderAccess(accountScreen(), { me: mayaMe() });
    await screen.findByRole("heading", { level: 1, name: "Account" });
    expect(container.querySelector('[data-slot="account-privacy"]')).not.toBeNull();
  });

  it("saves a new name and reports it only once the api confirms", async () => {
    const user = userEvent.setup();
    const saved = mayaMe({ user: { displayName: "Maya R." } as never });
    const api = createFakeAccessApi({ updateDisplayName: vi.fn(async () => saved) });
    renderAccess(accountScreen(), { api, me: mayaMe() });
    const field = await screen.findByLabelText("Name");
    await user.clear(field);
    await user.type(field, "Maya R.");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(api.updateDisplayName).toHaveBeenCalledWith("Maya R."));
    expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
  });

  it("keeps the draft and offers a retry when saving fails", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      updateDisplayName: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderAccess(accountScreen(), { api, me: mayaMe() });
    const field = await screen.findByLabelText("Name");
    await user.clear(field);
    await user.type(field, "Maya Rao II");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(
      await screen.findByText(
        "Symplist couldn't be reached, so your name wasn't saved. Try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Couldn't save — draft kept")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Maya Rao II");
  });

  it("refuses an empty name without calling the api", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ updateDisplayName: vi.fn() });
    renderAccess(accountScreen(), { api, me: mayaMe() });
    const field = await screen.findByLabelText("Name");
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(
      await screen.findByText("Enter a name so Symplist knows what to call you."),
    ).toBeInTheDocument();
    expect(api.updateDisplayName).not.toHaveBeenCalled();
  });

  it("asks before leaving with an unsaved name, and lets the person stay", async () => {
    const user = userEvent.setup();
    renderAccess(accountScreen(), { me: mayaMe() });
    const field = await screen.findByLabelText("Name");
    await user.clear(field);
    await user.type(field, "Maya R.");
    await user.click(screen.getByRole("link", { name: "Appearance" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Leave without saving your name?");
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveValue("Maya R.");
  });

  it("navigates after the person discards the unsaved name", async () => {
    const user = userEvent.setup();
    renderAccess(accountScreen(), { me: mayaMe() });
    const field = await screen.findByLabelText("Name");
    await user.clear(field);
    await user.type(field, "Maya R.");
    await user.click(screen.getByRole("link", { name: "Appearance" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/settings/appearance"));
  });

  it("keeps deletion in its own area, away from the ordinary save action", async () => {
    renderAccess(accountScreen(), { me: mayaMe() });
    const danger = (await screen.findByRole("heading", { name: "Delete this account" })).closest(
      "[data-slot='danger-zone']",
    );
    expect(danger).not.toBeNull();
    expect(
      within(danger as HTMLElement).getByRole("button", { name: "Delete account" }),
    ).toBeInTheDocument();
    expect(
      within(danger as HTMLElement).queryByRole("button", { name: "Save name" }),
    ).not.toBeInTheDocument();
  });

  it("signs out from the account section", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ logout: vi.fn(async () => undefined) });
    renderAccess(accountScreen(), { api, me: mayaMe() });
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(location.assign).toHaveBeenCalledWith("/signin"));
  });

  it("names the state of an account that is not admitted", async () => {
    renderAccess(accountScreen(), {
      me: mayaMe({ access: { ...admittedAccess, betaState: "relocked" } }),
    });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });
});
