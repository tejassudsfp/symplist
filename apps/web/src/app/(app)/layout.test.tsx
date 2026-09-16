import { render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "@/components/app-providers";

const navigation = vi.hoisted(() => ({ pathname: "/now" }));

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
  return render(<AppProviders nonce={undefined}>{tree}</AppProviders>);
}

function slot(name: string): HTMLElement {
  const elements = document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`);
  expect(elements).toHaveLength(1);
  return elements[0] as HTMLElement;
}

beforeEach(() => {
  navigation.pathname = "/now";
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
    // The session is still loading, so the profile control names no one.
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
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
});
