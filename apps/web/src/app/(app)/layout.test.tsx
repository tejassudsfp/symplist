import { render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "@/components/app-providers";
import { FakeWorkspaceApi } from "@/features/workspace/test-support";

const navigation = vi.hoisted(() => ({ pathname: "/now" }));

/**
 * The `(app)` layout mounts `WorkspaceProvider` (through `FeatureSlots`) around every route, so each
 * render here loads tasks and preferences. An in-memory api stands behind them; without one the
 * fetches go nowhere in jsdom and the shell never leaves its loading state.
 */
const workspace = vi.hoisted(() => ({ api: { current: null as unknown } }));

vi.mock("@/features/workspace/api", async () => {
  const actual = await vi.importActual<typeof import("@/features/workspace/api")>(
    "@/features/workspace/api",
  );
  return { ...actual, createWorkspaceApi: () => workspace.api.current };
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
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
  workspace.api.current = new FakeWorkspaceApi([{ id: taskId, title: "Refresh my portfolio" }]);
  const { mayaMe } = await import("@/features/access/test-support");
  const { resetSharedSessionStoreForTests } = await import("@/features/access/session-runtime");
  session.me = mayaMe();
  resetSharedSessionStoreForTests();
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
    expect(within(chat).getByText("No messages yet")).toBeInTheDocument();
    // The quick chat launcher belongs to the no-selection view.
    expect(document.querySelector('[data-slot="quick-chat"]')).toBeNull();
  });

  it("leaves the slots of features that render nothing yet empty", async () => {
    await renderAppLayout("/now");
    for (const name of [
      "vault-status",
      "notification-control",
      "quick-chat",
      "command-palette",
      "consent-banner",
    ]) {
      expect(slot(name)).toBeEmptyDOMElement();
    }
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
