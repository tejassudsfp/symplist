import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "@/components/app-providers";
import { FakeWorkspaceApi } from "@/features/workspace/test-support";

const navigation = vi.hoisted(() => ({ pathname: "/now", push: vi.fn() }));

/**
 * The `(app)` layout mounts `WorkspaceProvider` (through `FeatureSlots`) around every route, so each
 * render here loads tasks and preferences. An in-memory api stands behind them; without one the
 * fetches go nowhere in jsdom and the shell never leaves its loading state.
 */
const workspace = vi.hoisted(() => ({ api: { current: null as unknown } }));
const simon = vi.hoisted(() => ({ api: { current: null as unknown } }));

vi.mock("@/features/workspace/api", async () => {
  const actual = await vi.importActual<typeof import("@/features/workspace/api")>(
    "@/features/workspace/api",
  );
  return { ...actual, createWorkspaceApi: () => workspace.api.current };
});

vi.mock("@/features/simon/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/features/simon/api")>("@/features/simon/api");
  return { ...actual, createSimonApi: () => simon.api.current };
});

/*
 * The access feature resolves the session from `GET /v1/me`; the layout's gate renders the shell only
 * for an admitted account, so the identity is stubbed at the transport.
 */
const session = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("@/features/access/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/access/api")>();
  return {
    ...actual,
    getAccessApi: () => ({ me: async () => session.me }),
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
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

/** Renders the `(app)` layout under the root providers, as the root layout does. */
async function renderAppLayout(path: string, page: ReactNode = null) {
  navigation.pathname = path;
  const { default: AppLayout } = await import("./layout.tsx");
  const tree = await AppLayout({ children: page });
  const result = render(<AppProviders nonce={undefined}>{tree}</AppProviders>);
  // The gate renders the shell once the identity has resolved.
  await screen.findByRole("banner");
  return result;
}

function slot(name: string): HTMLElement {
  const elements = document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`);
  expect(elements).toHaveLength(1);
  return elements[0] as HTMLElement;
}

beforeEach(async () => {
  navigation.pathname = "/now";
  navigation.push.mockReset();
  workspace.api.current = new FakeWorkspaceApi([{ id: taskId, title: "Refresh my portfolio" }]);
  const conversationId = "01995000-0000-7000-8000-000000000001";
  simon.api.current = {
    create: async () => ({ conversationId }),
    history: async () => ({
      conversationId,
      kind: "task",
      taskId,
      activeRun: null,
      latestRun: null,
      pendingApprovalId: null,
      pendingAskId: null,
      messages: [],
      nextBeforeSeq: null,
    }),
  };
  const { mayaMe } = await import("@/features/access/test-support");
  const { resetSharedSessionStoreForTests } = await import("@/features/access/session-runtime");
  const { resetAnalytics } = await import("@/features/analytics/runtime");
  session.me = mayaMe();
  resetSharedSessionStoreForTests();
  resetAnalytics();
});

/*
 * The shell with today's seam placeholders (§2.3). A feature that replaces its placeholder updates
 * the matching assertion; where each seam mounts is covered by `components/shell/feature-slots.test.tsx`.
 */
describe("the (app) layout with the feature placeholders", () => {
  it("shows a selected task's page and chat", async () => {
    await renderAppLayout(`/now/${taskId}`);
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Task page" })).toBeInTheDocument();
    // The documents feature owns the page: with no API origin in this build it says so in plain
    // language rather than throwing inside the shell (system_states.md).
    expect(await within(main).findByText("This page isn't available here")).toBeInTheDocument();
    const chat = screen.getByRole("complementary", { name: "Simon" });
    expect(within(chat).getByRole("textbox", { name: "Message Simon" })).toBeInTheDocument();
    expect(within(chat).getByText(/Ask Simon about this task/)).toBeInTheDocument();
    // The quick chat launcher belongs to the no-selection view.
    expect(document.querySelector('[data-slot="quick-chat"]')).toBeNull();
  });

  it("mounts built shell slots and exposes the consent load failure safely", async () => {
    await renderAppLayout("/now");
    expect(within(slot("quick-chat")).getByRole("button", { name: "Ask Simon" })).toBeEnabled();
    expect(slot("command-palette")).toBeEmptyDOMElement();
    expect(slot("vault-status")).toHaveTextContent("Vault uses a separate key");
    expect(
      within(slot("notification-control")).getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(await within(slot("consent-banner")).findByRole("alert")).toHaveTextContent(
      "Your privacy choice could not be loaded. Product usage sharing stays off.",
    );
    expect(within(slot("consent-banner")).getByRole("button", { name: "Try again" })).toBeEnabled();
    // The access feature resolved the session, so the profile control names the account.
    expect(
      await screen.findByRole("button", { name: "Account menu, Maya Rao" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("renders the route's own content outside the workspace", async () => {
    await renderAppLayout("/settings/account", <h1>Account settings</h1>);
    expect(
      within(screen.getByRole("main")).getByRole("heading", { name: "Account settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Nothing on this page yet")).not.toBeInTheDocument();
    slot("command-palette");
    slot("consent-banner");
  });

  it("gives the inbox pane the workspace's own list", async () => {
    const { unmount } = await renderAppLayout("/now");
    const inbox = await screen.findByRole("tree", { name: "Now tasks" });
    expect(within(inbox).getByText("Refresh my portfolio")).toBeInTheDocument();
    expect(screen.getByLabelText("Add task to Now")).toBeInTheDocument();
    unmount();

    // A route outside the collections is not the workspace, so the shell shows it on its own: the
    // provider stays mounted (`FeatureSlots` wraps the whole group) but the panels do not.
    await renderAppLayout("/settings/account", <h1>Account settings</h1>);
    await screen.findByRole("heading", { name: "Account settings" });
    expect(screen.queryByRole("tree", { name: "Now tasks" })).not.toBeInTheDocument();
  });
});

/*
 * Keyboard remapping only becomes live where the whole chain is assembled, which is here and nowhere
 * else: the workspace feature reads the account's `keyboard` group and hands it to `FeatureSlots` as
 * `keyboardPreferences`, `AppShell` passes it to `ActionsProvider`, and the dispatcher resolves
 * `effectiveBindings` against it on every key event. Each half is unit-tested on its own, and each
 * half passes with the other missing while every remap silently does nothing -- which is exactly the
 * state the shell was in before the workspace and search features were merged. This case fails if
 * any link in that chain is dropped.
 */
describe("the account's keyboard preferences through the (app) layout", () => {
  it("runs a remapped shortcut and leaves its default binding inert", async () => {
    const api = new FakeWorkspaceApi([{ id: taskId, title: "Refresh my portfolio" }]);
    api.setPreference("keyboard", {
      overrides: { "shell.go_later": "g b" },
      singleKeyShortcuts: true,
    });
    workspace.api.current = api;
    const user = userEvent.setup();
    await renderAppLayout("/now");
    await screen.findByRole("tree", { name: "Now tasks" });

    // The preference load is a fetch of its own, so the remap becomes effective a tick after the
    // list does; retrying the chord is what waits for it.
    await waitFor(async () => {
      await user.keyboard("gb");
      expect(navigation.push).toHaveBeenCalledWith("/later");
    });

    navigation.push.mockClear();
    await user.keyboard("gl");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("falls back to the default binding when the account has no remap", async () => {
    const user = userEvent.setup();
    await renderAppLayout("/now");
    await screen.findByRole("tree", { name: "Now tasks" });

    await user.keyboard("gl");
    expect(navigation.push).toHaveBeenCalledWith("/later");
    navigation.push.mockClear();
    await user.keyboard("gb");
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
