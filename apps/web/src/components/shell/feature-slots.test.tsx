import { userIdSchema } from "@symplist/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppLayout from "@/app/(app)/layout";
import { AppProviders } from "@/components/app-providers";
import type { Session } from "@/features/access/session";
import { FakeWorkspaceApi } from "@/features/workspace/test-support";

/*
 * Where each feature seam mounts (§2.3). Every seam module is replaced by a marker, so this file keeps
 * passing as features replace their placeholders; `app/(app)/layout.test.tsx` covers the placeholders.
 */

const navigation = vi.hoisted(() => ({ pathname: "/now" }));

const seams = vi.hoisted(() => ({
  session: { status: "loading" } as Session,
  /** Each entry is one mount, recorded by a state initializer (which never reruns on update). */
  mounts: { document: [] as string[], chat: [] as string[], palette: 0, banner: 0 },
  /**
   * `FeatureSlots` mounts `WorkspaceProvider` around the whole `(app)` layout, so every render here
   * loads tasks and preferences. Without a fake behind it those fetches go nowhere in jsdom and the
   * shell's inbox and header never leave their loading state.
   */
  workspaceApi: { current: null as unknown },
}));

vi.mock("@/features/workspace/api", async () => {
  const actual = await vi.importActual<typeof import("@/features/workspace/api")>(
    "@/features/workspace/api",
  );
  return { ...actual, createWorkspaceApi: () => seams.workspaceApi.current };
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

vi.mock("@/features/access/session", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => (
    <div data-seam="session-provider">{children}</div>
  ),
  useSession: () => seams.session,
  SessionGate: ({ children, require }: { children: ReactNode; require: string }) => (
    <div data-seam="session-gate" data-require={require}>
      {children}
    </div>
  ),
}));

vi.mock("@/features/documents/document-pane", async () => {
  const { useState } = await import("react");
  return {
    DocumentPane: ({ taskId }: { taskId: string }) => {
      useState(() => seams.mounts.document.push(taskId));
      return <p data-seam="document-pane">{`Page of ${taskId}`}</p>;
    },
  };
});

vi.mock("@/features/simon/chat-pane", async () => {
  const { useState } = await import("react");
  return {
    ChatPane: ({ taskId }: { taskId: string }) => {
      useState(() => seams.mounts.chat.push(taskId));
      return <p data-seam="chat-pane">{`Chat about ${taskId}`}</p>;
    },
  };
});

vi.mock("@/features/search/command-palette", async () => {
  const { useState } = await import("react");
  return {
    CommandPalette: () => {
      useState(() => {
        seams.mounts.palette += 1;
      });
      return <p data-seam="command-palette">Command palette</p>;
    },
  };
});

vi.mock("@/features/analytics/consent-banner", async () => {
  const { useState } = await import("react");
  return {
    ConsentBanner: () => {
      useState(() => {
        seams.mounts.banner += 1;
      });
      return <p data-seam="consent-banner">Consent banner</p>;
    },
  };
});

vi.mock("@/features/simon/quick-chat", () => ({
  QuickChatLauncher: () => <button type="button">Quick chat</button>,
}));

vi.mock("@/features/scheduling/notification-control", () => ({
  NotificationControl: () => <button type="button">Notifications</button>,
}));

vi.mock("@/features/vault/vault-status", () => ({
  VaultStatus: () => <span>Vault locked</span>,
}));

const taskA = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
const taskB = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8b";

/** The root providers around the `(app)` layout, as the root layout renders them. */
async function appTree(path: string) {
  navigation.pathname = path;
  return <AppProviders nonce={undefined}>{await AppLayout({ children: null })}</AppProviders>;
}

function slot(name: string): HTMLElement {
  const elements = document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`);
  expect(elements).toHaveLength(1);
  return elements[0] as HTMLElement;
}

function seam(name: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-seam="${name}"]`)];
}

beforeEach(() => {
  seams.session = { status: "loading" };
  seams.mounts = { document: [], chat: [], palette: 0, banner: 0 };
  seams.workspaceApi.current = new FakeWorkspaceApi([
    { id: taskA, title: "Refresh my portfolio" },
    { id: taskB, title: "Send the project outline" },
    {
      id: "0192a000-0000-7000-8000-00000000000c",
      title: "Plan a quiet weekend",
      collection: "later",
    },
  ]);
});

describe("feature seams in the app shell", () => {
  it("wraps every route in the root session and the (app) group's admitted gate", async () => {
    render(await appTree("/now"));
    const [provider] = seam("session-provider");
    const [gate] = seam("session-gate");
    expect(seam("session-provider")).toHaveLength(1);
    expect(seam("session-gate")).toHaveLength(1);
    expect(gate).toHaveAttribute("data-require", "admitted");
    expect(provider).toContainElement(gate as HTMLElement);
    expect(gate).toContainElement(screen.getByRole("banner"));
  });

  it("mounts the page, chat and top bar seams for a selected task", async () => {
    render(await appTree(`/now/${taskA}`));
    expect(within(screen.getByRole("main")).getByText(`Page of ${taskA}`)).toBeInTheDocument();
    expect(
      within(screen.getByRole("complementary", { name: "Simon" })).getByText(`Chat about ${taskA}`),
    ).toBeInTheDocument();
    expect(within(slot("vault-status")).getByText("Vault locked")).toBeInTheDocument();
    expect(
      within(slot("notification-control")).getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-slot="quick-chat"]')).toBeNull();
    expect(seam("document-pane")).toHaveLength(1);
    expect(seam("chat-pane")).toHaveLength(1);
  });

  it("offers quick chat only while no task is selected", async () => {
    render(await appTree("/later"));
    expect(
      within(slot("quick-chat")).getByRole("button", { name: "Quick chat" }),
    ).toBeInTheDocument();
    expect(seam("document-pane")).toHaveLength(0);
    expect(seam("chat-pane")).toHaveLength(0);
  });

  it("shows the session's person in the profile control", async () => {
    seams.session = {
      status: "signed_in",
      user: {
        id: userIdSchema.parse("01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8c"),
        displayName: "Maya Rao",
        email: "maya@example.com",
        role: "admin",
      },
    };
    render(await appTree("/now"));
    expect(screen.getByRole("button", { name: "Account menu, Maya Rao" })).toHaveTextContent("MR");
  });

  it("mounts the palette and banner once and gives each task fresh panes", async () => {
    const { rerender } = render(await appTree(`/now/${taskA}`));
    rerender(await appTree(`/now/${taskB}`));
    // Moving the open task to another collection keeps its panes.
    rerender(await appTree(`/later/${taskB}`));
    rerender(await appTree("/settings/account"));
    rerender(await appTree("/now"));

    expect(seams.mounts.document).toEqual([taskA, taskB]);
    expect(seams.mounts.chat).toEqual([taskA, taskB]);
    expect(seams.mounts.palette).toBe(1);
    expect(seams.mounts.banner).toBe(1);
    expect(within(slot("command-palette")).getByText("Command palette")).toBeInTheDocument();
    expect(within(slot("consent-banner")).getByText("Consent banner")).toBeInTheDocument();
  });

  /*
   * The workspace's three shell seams (decision WS17). `FeatureSlots` mounts one `WorkspaceProvider`
   * around the whole layout, so the list, the page header and the chat subtitle read the same stores.
   */

  it("fills the inbox slot with the route's own collection", async () => {
    render(await appTree("/now"));
    const inbox = await screen.findByRole("tree", { name: "Now tasks" });
    expect(within(inbox).getByText("Refresh my portfolio")).toBeInTheDocument();
    expect(within(inbox).queryByText("Plan a quiet weekend")).not.toBeInTheDocument();
    // The list is inside the shell's inbox pane, which is what the keyboard actions address.
    expect(inbox.closest('[data-pane="inbox"]')).not.toBeNull();
  });

  it("switches the inbox to the collection the address names", async () => {
    render(await appTree("/later"));
    const inbox = await screen.findByRole("tree", { name: "Later tasks" });
    expect(within(inbox).getByText("Plan a quiet weekend")).toBeInTheDocument();
    expect(within(inbox).queryByText("Refresh my portfolio")).not.toBeInTheDocument();
  });

  it("fills the task header and the chat subtitle for the open task", async () => {
    render(await appTree(`/now/${taskA}`));
    // The header is the page frame's own, beside the page pane — not the row in the list.
    const header = screen.getByRole("main");
    await waitFor(() =>
      expect(within(header).getByLabelText("Complete Refresh my portfolio")).toBeInTheDocument(),
    );
    const chat = screen.getByRole("complementary", { name: "Simon" });
    expect(within(chat).getByText("Refresh my portfolio")).toBeInTheDocument();
  });
});
