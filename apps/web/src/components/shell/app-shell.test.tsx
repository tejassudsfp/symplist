import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_OUT_ACTION_ID, shellActions } from "@/actions/shell-actions";
import type { AppAction } from "@/actions/types";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "./app-shell.tsx";
import { collections } from "./routes.ts";
import { type ShellSlots, ShellSlotsProvider } from "./slots.tsx";
import { railItemSelector } from "./workspace.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/now",
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";

function renderShell(options: {
  path: string;
  slots?: ShellSlots;
  actions?: readonly AppAction[];
}) {
  navigation.pathname = options.path;
  return render(
    <StatusAnnouncerProvider>
      <TooltipProvider>
        <ShellSlotsProvider value={options.slots ?? {}}>
          <AppShell {...(options.actions ? { actions: options.actions } : {})}>
            <h1>Page content</h1>
          </AppShell>
        </ShellSlotsProvider>
      </TooltipProvider>
    </StatusAnnouncerProvider>,
  );
}

beforeEach(() => {
  navigation.push.mockReset();
});

describe("AppShell on a collection route", () => {
  it("renders the top bar, rail, task list and page", () => {
    renderShell({ path: "/now" });
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("link", { name: "Symplist home" })).toHaveAttribute(
      "href",
      "/now",
    );
    expect(within(banner).getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(within(banner).getByRole("link", { name: "Vault" })).toHaveAttribute("href", "/vault");
    const rails = screen.getAllByRole("navigation", { name: "Collections" });
    const rail = rails[0] as HTMLElement;
    expect(within(rail).getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("link", { name: "Later" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("region", { name: "Now" })).toHaveAttribute("data-pane", "inbox");
    expect(screen.getByRole("main")).toHaveAttribute("data-pane", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Page content" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize task list" })).toHaveAttribute(
      "aria-valuemin",
    );
  });

  it("uses feature slots when they are provided", () => {
    renderShell({
      path: "/later",
      slots: {
        inbox: (collection) => <p>{`Tasks in ${collection}`}</p>,
        notificationControl: <button type="button">Notifications</button>,
        identity: { displayName: "Maya Rao", email: "maya@example.com", isAdmin: false },
      },
    });
    expect(screen.getByText("Tasks in later")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu, Maya Rao" })).toHaveTextContent("MR");
  });
});

describe("AppShell on a task route", () => {
  it("keeps the page panel addressable when a task opens through client-side navigation", async () => {
    // Opening a task from the palette or a search result re-renders the workspace; the panel group
    // registers its panels in a layout effect, so the sync that follows must not crash the app.
    const { rerender } = renderShell({ path: "/now" });
    expect(screen.queryByRole("link", { name: "Back to Now" })).not.toBeInTheDocument();
    navigation.pathname = `/now/${taskId}`;
    await act(async () => {
      rerender(
        <StatusAnnouncerProvider>
          <TooltipProvider>
            <ShellSlotsProvider value={{}}>
              <AppShell>
                <h1>Page content</h1>
              </AppShell>
            </ShellSlotsProvider>
          </TooltipProvider>
        </StatusAnnouncerProvider>,
      );
    });
    expect(screen.getByRole("link", { name: "Back to Now" })).toHaveAttribute("href", "/now");
  });

  it("collapses the task list to the rail's Show task list control", async () => {
    const user = userEvent.setup();
    renderShell({ path: `/now/${taskId}` });
    await user.click(screen.getByRole("button", { name: "Hide task list" }));
    expect(document.querySelector(".sym-workspace")).toHaveAttribute("data-inbox", "collapsed");
    // Focus moves to the control that replaced the list, never to the hidden panel.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show task list" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Show task list" }));
    expect(document.querySelector(".sym-workspace")).toHaveAttribute("data-inbox", "expanded");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Now" })).toHaveFocus(),
    );
  });

  it("shows the page as the phone's single surface, with a way back to the collection", () => {
    renderShell({ path: `/now/${taskId}` });
    expect(document.querySelector(".sym-workspace")).toHaveAttribute("data-mobile-view", "page");
    renderShell({ path: "/now" });
    expect(document.querySelectorAll(".sym-workspace")[1]).toHaveAttribute(
      "data-mobile-view",
      "list",
    );
    expect(screen.getAllByRole("link", { name: "Back to Now" })[0]).toHaveAttribute("href", "/now");
  });
});

describe("AppShell outside the workspace", () => {
  it("renders a plain main region for settings and administration", () => {
    renderShell({ path: "/settings/appearance" });
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Collections" })).not.toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});

describe("keyboard actions through the shell", () => {
  it("runs g then l to navigate and g then d to focus the page", async () => {
    const user = userEvent.setup();
    renderShell({ path: `/now/${taskId}` });
    await user.keyboard("gl");
    expect(navigation.push).toHaveBeenCalledWith("/later");
    // Collection shortcuts focus the task list (note 13).
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Now" })).toHaveFocus(),
    );
    await user.keyboard("gd");
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("expands a collapsed task list before focusing it for a collection shortcut", async () => {
    const user = userEvent.setup();
    renderShell({ path: `/now/${taskId}` });
    await user.click(screen.getByRole("button", { name: "Hide task list" }));
    expect(document.querySelector(".sym-workspace")).toHaveAttribute("data-inbox", "collapsed");
    await user.keyboard("gn");
    expect(navigation.push).toHaveBeenCalledWith("/now");
    expect(document.querySelector(".sym-workspace")).toHaveAttribute("data-inbox", "expanded");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Now" })).toHaveFocus(),
    );
  });

  it("announces why a shortcut is unavailable", async () => {
    const user = userEvent.setup();
    renderShell({ path: "/now" });
    await user.keyboard("gd");
    const polite = document.querySelector('[data-slot="status-announcer"] [aria-live="polite"]');
    await waitFor(() => expect(polite).toHaveTextContent("Open task page: Open a task first"));
  });

  it("offers Sign out only through a registered action", async () => {
    const user = userEvent.setup();
    // Without the access feature's action in the registry the menu item stays inert.
    const { unmount } = renderShell({ path: "/now", actions: shellActions });
    screen.getByRole("button", { name: "Account menu" }).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: /Settings/ })).toHaveAttribute(
      "href",
      "/settings/account",
    );
    expect(
      within(menu).queryByRole("menuitem", { name: "Administration" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    unmount();
  });

  it("keeps both shortcut surfaces in the profile menu", async () => {
    // keyboard_shortcuts.md asks for two surfaces: the help overlay (opened by `?` or the menu) and
    // Settings → Keyboard shortcuts for remapping. The overlay entry is additional to the settings
    // link, never a replacement for it — dropping the link would strand the remapping page.
    const user = userEvent.setup();
    const { unmount } = renderShell({ path: "/now" });
    screen.getByRole("button", { name: "Account menu" }).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Keyboard shortcuts/ })).toHaveAttribute(
      "href",
      "/settings/shortcuts",
    );
    const help = within(menu).getByRole("menuitem", { name: /Shortcut help/ });
    expect(help).not.toHaveAttribute("href");
    expect(help).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    unmount();
  });

  it("signs out through the access feature's action and shows administration to admins", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn();
    const signOutAction: AppAction = {
      id: SIGN_OUT_ACTION_ID,
      label: "Sign out",
      context: "app",
      availability: () => ({ enabled: true }),
      run: signOut,
    };
    renderShell({
      path: "/now",
      actions: [...shellActions, signOutAction],
      slots: { identity: { displayName: "Maya Rao", email: "maya@example.com", isAdmin: true } },
    });
    screen.getByRole("button", { name: "Account menu, Maya Rao" }).focus();
    await user.keyboard("{Enter}");
    const adminMenu = await screen.findByRole("menu");
    expect(within(adminMenu).getByRole("menuitem", { name: "Administration" })).toHaveAttribute(
      "href",
      "/admin/invites",
    );
    await user.click(within(adminMenu).getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(signOut.mock.calls[0]?.[0]).toMatchObject({ source: "menu" });
  });

  it("keeps the rail items other features address as drop destinations", () => {
    renderShell({ path: "/now" });
    // `railItemSelector` is how the workspace's drag layer finds a collection to drop a task on
    // (decision WS22). Renaming the markup without it is a silently dead selector, not an error.
    for (const { id } of collections) {
      const item = document.querySelector(railItemSelector(id));
      expect(item, `no rail item matches ${railItemSelector(id)}`).not.toBeNull();
      expect(item).toHaveAttribute("href", `/${id}`);
    }
  });
});
