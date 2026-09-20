import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  adminEventFixture,
  createFakeAccessApi,
  mayaMe,
  mayaUserId,
  renderAccess,
  stubNavigation,
} from "../../test-support.tsx";
import { ActivityLog } from "./activity-log.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/activity",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let location = stubNavigation("/admin/activity");

beforeEach(() => {
  navigation.search = "";
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/admin/activity");
});

afterEach(() => {
  location.restore();
});

const admin = mayaMe({ user: { role: "admin" } as never });

const redeemed = adminEventFixture();
const capacityChanged = adminEventFixture({
  id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0ee002",
  createdAt: Date.UTC(2026, 8, 3, 9),
  actor: { kind: "admin", id: mayaUserId, email: "tejas@example.com" },
  action: "invite_capacity_changed",
  target: { kind: "invite", id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e1001", label: "WXYZ" },
  before: { maxRedemptions: 5 },
  after: { maxRedemptions: 8 },
  hasReason: false,
});

describe("the activity log (admin_activity.md)", () => {
  it("reads as sentences, newest first, with no edit or delete control", async () => {
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [capacityChanged, redeemed], nextCursor: null })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    expect(
      await screen.findByText(
        "tejas@example.com increased capacity from 5 to 8 for Friends — September",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("maya@example.com redeemed Friends — September")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete|edit/i })).not.toBeInTheDocument();
    // Invite usage only: no model usage, credits or quotas.
    expect(screen.queryByText(/token|credit|quota|plan/i)).not.toBeInTheDocument();
  });

  it("shows the result of a change and never a full code", async () => {
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [capacityChanged], nextCursor: null })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    expect(await screen.findByText("max redemptions 5 → 8")).toBeInTheDocument();
    expect(screen.queryByText(/SYM(-[A-Z2-7]{4}){8}/)).not.toBeInTheDocument();
  });

  it("opens an event's recorded reason and before/after values", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [capacityChanged], nextCursor: null })),
      activityDetail: vi.fn(async () => ({
        event: capacityChanged,
        reason: "More seats for the September group",
        reasonUnavailable: false,
      })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByText(/More seats for the September group/)).toBeInTheDocument();
    expect(screen.getByText(/max redemptions 5/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide details" }));
    await waitFor(() =>
      expect(screen.queryByText(/More seats for the September group/)).not.toBeInTheDocument(),
    );
  });

  it("says when a reason can no longer be read because its account was deleted", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [capacityChanged], nextCursor: null })),
      activityDetail: vi.fn(async () => ({
        event: capacityChanged,
        reason: null,
        reasonUnavailable: true,
      })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Details" }));
    expect(
      await screen.findByText(/no longer readable — the account it belonged to was deleted/),
    ).toBeInTheDocument();
  });

  it("filters by action and keeps the filter in the address", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [redeemed], nextCursor: null })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    await screen.findByText("maya@example.com redeemed Friends — September");
    await user.selectOptions(screen.getByLabelText("Action"), "account_unlocked");
    await waitFor(() =>
      expect(api.listActivity).toHaveBeenCalledWith(
        { action: "account_unlocked" },
        expect.anything(),
      ),
    );
    expect(navigation.replace).toHaveBeenCalledWith("/admin/activity?action=account_unlocked");
  });

  it("filters by date range", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [redeemed], nextCursor: null })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    await screen.findByText("maya@example.com redeemed Friends — September");
    await user.type(screen.getByLabelText("From"), "2026-09-01");
    await user.click(screen.getByRole("button", { name: "Apply dates" }));
    await waitFor(() => {
      const last = (api.listActivity as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(
        -1,
      );
      expect(last?.[0]).toMatchObject({ from: expect.any(Number) });
    });
  });

  it("narrows to one account when the address names one, and can show everything again", async () => {
    navigation.search = `accountId=${mayaUserId}`;
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [redeemed], nextCursor: null })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    await waitFor(() =>
      expect(api.listActivity).toHaveBeenCalledWith({ accountId: mayaUserId }, expect.anything()),
    );
    expect(await screen.findByText(/Showing events for one account only/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show everything" })).toHaveAttribute(
      "href",
      "/admin/activity",
    );
  });

  it("links a row to the invite it concerns", async () => {
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [redeemed], nextCursor: null })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    const row = (await screen.findByText("maya@example.com redeemed Friends — September")).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByRole("link", { name: "WXYZ" })).toHaveAttribute(
      "href",
      "/admin/invites/01929f3e-7c1a-7b2e-9a55-3c2f1d0e1001",
    );
  });

  it("shows empty, loading and failure states", async () => {
    const user = userEvent.setup();
    const empty = createFakeAccessApi({
      listActivity: vi.fn(async () => ({ items: [], nextCursor: null })),
    });
    const { unmount } = renderAccess(<ActivityLog />, { api: empty, me: admin });
    expect(await screen.findByText("Nothing has happened yet")).toBeInTheDocument();
    unmount();

    let fail = true;
    const failing = createFakeAccessApi({
      listActivity: vi.fn(async () => {
        if (fail) throw new ApiNetworkError();
        return { items: [redeemed], nextCursor: null };
      }),
    });
    renderAccess(<ActivityLog />, { api: failing, me: admin });
    expect(await screen.findByText("Couldn't load activity")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("maya@example.com redeemed Friends — September"),
    ).toBeInTheDocument();
  });

  it("names a deleted account rather than showing nothing", async () => {
    const api = createFakeAccessApi({
      listActivity: vi.fn(async () => ({
        items: [
          adminEventFixture({
            action: "access_relocked",
            actor: { kind: "admin", id: null, email: null },
            target: { kind: "user", id: null, label: null },
            campaign: null,
          }),
        ],
        nextCursor: null,
      })),
    });
    renderAccess(<ActivityLog />, { api, me: admin });
    expect(
      await screen.findByText("Deleted account relocked access · Deleted account"),
    ).toBeInTheDocument();
  });
});
