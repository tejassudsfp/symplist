import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_OUT_ACTION_ID, shellActions } from "@/actions/shell-actions";
import type { AppAction } from "@/actions/types";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "./app-shell.tsx";
import { type ShellSlots, ShellSlotsProvider } from "./slots.tsx";

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
  it("renders the top bar, rail, task list and page with a quick chat slot", () => {
    renderShell({ path: "/now", slots: { quickChat: <button type="button">Quick chat</button> } });
    const banner = screen.getByRole("banner");
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
    expect(document.querySelector('[data-slot="quick-chat"]')).toContainElement(
      screen.getByRole("button", { name: "Quick chat" }),
    );
    expect(screen.getByRole("separator", { name: "Resize task list" })).toHaveAttribute(
      "aria-valuemin",
    );
  });

  it("uses feature slots when they are provided", () => {
    renderShell({
      path: "/later",
      slots: {
        inbox: (collection) => <p>{`Tasks in ${collection}`}</p>,
        runningIndicator: <span>Simon is working on “Plan a quiet weekend”</span>,
        notificationControl: <button type="button">Notifications</button>,
        identity: { displayName: "Maya Rao", email: "maya@example.com", isAdmin: false },
      },
    });
    expect(screen.getByText("Tasks in later")).toBeInTheDocument();
    expect(screen.getByText(/Simon is working on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu, Maya Rao" })).toHaveTextContent("MR");
  });
});

describe("AppShell on a task route", () => {
  it("adds the chat panel and collapses it to a corner control", async () => {
    const user = userEvent.setup();
    renderShell({
      path: `/now/${taskId}`,
      slots: {
        chatTitle: () => "Refresh my portfolio",
        chatStatus: (id) => (id === taskId ? "Approval waiting" : null),
      },
    });
    const chat = screen.getByRole("complementary", { name: "Simon" });
    expect(chat).toHaveAttribute("data-pane", "chat");
    expect(within(chat).getByText("Refresh my portfolio")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide chat" }));
    const corner = await screen.findByRole("button", { name: "Show chat, Approval waiting" });
    expect(corner.querySelector('[data-slot="chat-status"]')).not.toBeNull();
    expect(document.querySelector(".sym-workspace")).toHaveAttribute("data-chat", "collapsed");
    await waitFor(() => expect(corner).toHaveFocus());
    await user.click(corner);
    expect(document.querySelector(".sym-workspace")).toHaveAttribute("data-chat", "expanded");
    expect(screen.queryByRole("button", { name: /Show chat/ })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Simon" })).toHaveFocus(),
    );
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

  it("switches the phone surfaces between page and chat", async () => {
    const user = userEvent.setup();
    renderShell({ path: `/now/${taskId}` });
    const workspace = document.querySelector(".sym-workspace");
    expect(workspace).toHaveAttribute("data-mobile-view", "page");
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(workspace).toHaveAttribute("data-mobile-view", "chat");
    await user.click(screen.getByRole("button", { name: "Page", exact: true } as never));
    expect(workspace).toHaveAttribute("data-mobile-view", "page");
    expect(screen.getByRole("link", { name: "Back to Now" })).toHaveAttribute("href", "/now");
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
  it("runs g then l to navigate and g then c to focus the chat", async () => {
    const user = userEvent.setup();
    renderShell({ path: `/now/${taskId}` });
    await user.keyboard("gl");
    expect(navigation.push).toHaveBeenCalledWith("/later");
    // Collection shortcuts focus the task list (note 13).
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Now" })).toHaveFocus(),
    );
    await user.keyboard("gc");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: "Simon" })).toHaveFocus(),
    );
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
    await user.keyboard("gc");
    const polite = document.querySelector('[data-slot="status-announcer"] [aria-live="polite"]');
    await waitFor(() => expect(polite).toHaveTextContent("Open Simon chat: Open a task first"));
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
      within(menu).queryByRole("menuitem", { name: "Beta administration" }),
    ).not.toBeInTheDocument();
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
    expect(
      within(adminMenu).getByRole("menuitem", { name: "Beta administration" }),
    ).toHaveAttribute("href", "/admin/invites");
    await user.click(within(adminMenu).getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(signOut.mock.calls[0]?.[0]).toMatchObject({ source: "menu" });
  });
});
