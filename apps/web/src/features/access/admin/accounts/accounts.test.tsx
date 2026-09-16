import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  accessApiError,
  adminAccountFixture,
  adminEventFixture,
  adminInviteFixture,
  createFakeAccessApi,
  mayaMe,
  mayaUserId,
  renderAccess,
  stubNavigation,
} from "../../test-support.tsx";
import { AccountDetail } from "./account-detail.tsx";
import { AccountList } from "./account-list.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/accounts",
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

let location = stubNavigation("/admin/accounts");

beforeEach(() => {
  navigation.search = "";
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/admin/accounts");
});

afterEach(() => {
  location.restore();
});

const admin = mayaMe({ user: { role: "admin" } as never });

const grant = {
  id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e3001",
  source: "invite" as const,
  inviteId: adminInviteFixture().id,
  inviteHint: "WXYZ",
  campaignId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0ec001",
  grantedAt: Date.UTC(2026, 8, 2, 11),
  actorId: null,
  reason: null,
  revokedAt: null,
  revokedReason: null,
};

function detail(account = adminAccountFixture()) {
  return {
    account,
    grants: [grant],
    redemptions: [
      {
        id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e2001",
        inviteId: adminInviteFixture().id,
        inviteHint: "WXYZ",
        campaignId: grant.campaignId,
        seatNo: 1,
        accessEpoch: 0,
        redeemedAt: Date.UTC(2026, 8, 2, 10),
      },
    ],
    events: [adminEventFixture()],
  };
}

describe("the account list (admin_accounts.md)", () => {
  it("shows identity, verification, access, onboarding and grant source, and no private content", async () => {
    const api = createFakeAccessApi({
      listAccounts: vi.fn(async () => ({ items: [adminAccountFixture()], nextCursor: null })),
    });
    renderAccess(<AccountList />, { api, me: admin });
    const row = (await screen.findByRole("link", { name: "Maya Rao" })).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByText("maya@example.com")).toBeInTheDocument();
    expect(within(row).getByText("Unlocked")).toBeInTheDocument();
    expect(within(row).getByText("Finished")).toBeInTheDocument();
    expect(within(row).getByText("Invite code")).toBeInTheDocument();
    expect(screen.queryByText(/task|vault|conversation/i)).not.toBeInTheDocument();
  });

  it("distinguishes a pending registration from a verified locked account", async () => {
    const api = createFakeAccessApi({
      listAccounts: vi.fn(async () => ({
        items: [
          adminAccountFixture({ emailVerifiedAt: null, betaState: "locked", grantSource: null }),
          adminAccountFixture({
            id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9001" as ReturnType<
              typeof adminAccountFixture
            >["id"],
            email: "sam@example.com",
            displayName: null,
            betaState: "locked",
            grantSource: null,
          }),
        ],
        nextCursor: null,
      })),
    });
    renderAccess(<AccountList />, { api, me: admin });
    expect(await screen.findByText("Pending verification")).toBeInTheDocument();
    // "Locked" appears as the state of the verified account and as a filter button.
    expect(screen.getAllByText("Locked").length).toBeGreaterThan(0);
    expect(screen.getByText("Not verified")).toBeInTheDocument();
  });

  it("filters to newly verified locked accounts and keeps the filter in the address", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listAccounts: vi.fn(async () => ({ items: [adminAccountFixture()], nextCursor: null })),
    });
    renderAccess(<AccountList />, { api, me: admin });
    await screen.findByRole("link", { name: "Maya Rao" });
    await user.click(screen.getByRole("button", { name: "Locked" }));
    await waitFor(() =>
      expect(api.listAccounts).toHaveBeenCalledWith({ filter: "locked" }, expect.anything()),
    );
    expect(navigation.replace).toHaveBeenCalledWith("/admin/accounts?filter=locked");
  });

  it("searches by email and explains when nothing matches", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listAccounts: vi.fn(async () => ({ items: [], nextCursor: null })),
    });
    renderAccess(<AccountList />, { api, me: admin });
    await user.type(await screen.findByLabelText(/Search accounts/), "nobody");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No accounts match these filters")).toBeInTheDocument();
  });

  it("reports a failed load with a retry", async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = createFakeAccessApi({
      listAccounts: vi.fn(async () => {
        if (fail) throw new ApiNetworkError();
        return { items: [adminAccountFixture()], nextCursor: null };
      }),
    });
    renderAccess(<AccountList />, { api, me: admin });
    expect(await screen.findByText("Couldn't load accounts")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Maya Rao" })).toBeInTheDocument();
  });
});

describe("one account (admin_accounts.md)", () => {
  it("shows the admission history and the invite behind the grant", async () => {
    const api = createFakeAccessApi({ accountDetail: vi.fn(async () => detail()) });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    expect(await screen.findByRole("heading", { name: "Maya Rao" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invite SYM-…-WXYZ" })).toHaveAttribute(
      "href",
      `/admin/invites/${adminInviteFixture().id}`,
    );
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See every event for this account" })).toHaveAttribute(
      "href",
      `/admin/activity?accountId=${mayaUserId}`,
    );
  });

  it("offers only the actions that apply, and never a role control", async () => {
    const api = createFakeAccessApi({ accountDetail: vi.fn(async () => detail()) });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    expect(await screen.findByRole("button", { name: "Relock access" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unlock account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /administrator|role/i })).not.toBeInTheDocument();
  });

  it("unlocks a locked account with a reason and the generation it read", async () => {
    const user = userEvent.setup();
    const locked = adminAccountFixture({ betaState: "locked", grantSource: null });
    const api = createFakeAccessApi({
      accountDetail: vi.fn(async () => detail(locked)),
      accountAction: vi.fn(async () => adminAccountFixture({ accessGeneration: 3 })),
    });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Unlock account" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/No invite code is created or sent/);
    const confirm = within(dialog).getByRole("button", { name: "Unlock account" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Reason"), "Friend of the project");
    await user.click(confirm);
    await waitFor(() =>
      expect(api.accountAction).toHaveBeenCalledWith(
        locked.id,
        "unlock",
        { reason: "Friend of the project", expectedGeneration: 2 },
        expect.any(String),
      ),
    );
    expect(await screen.findByText("Account unlocked.")).toBeInTheDocument();
  });

  it("says that unlocking a pending account never verifies its email", async () => {
    const api = createFakeAccessApi({
      accountDetail: vi.fn(async () =>
        detail(
          adminAccountFixture({ emailVerifiedAt: null, betaState: "locked", grantSource: null }),
        ),
      ),
    });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    expect(
      await screen.findByText(/Unlocking grants beta access but never verifies the email/),
    ).toBeInTheDocument();
  });

  it("explains what relocking stops, without promising external actions are undone", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ accountDetail: vi.fn(async () => detail()) });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Relock access" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/running work is stopped where that is possible/);
    expect(dialog).toHaveTextContent(/Actions already completed outside Symplist can't be undone/);
    expect(dialog).toHaveTextContent(/The invite seat is not refunded/);
  });

  it("offers both restores for a paused account", async () => {
    const api = createFakeAccessApi({
      accountDetail: vi.fn(async () => detail(adminAccountFixture({ betaState: "relocked" }))),
    });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    expect(await screen.findByRole("button", { name: "Restore eligibility" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore access" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Relock access" })).not.toBeInTheDocument();
  });

  it("refuses an action on an account that changed since it was read", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      accountDetail: vi.fn(async () => detail()),
      accountAction: vi.fn(async () => {
        throw accessApiError("admin.state_changed", 409);
      }),
    });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Relock access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Reason"), "Abuse report");
    await user.click(within(dialog).getByRole("button", { name: "Relock access" }));
    expect(
      await screen.findByText(
        "This account changed since you opened it. Reload it and decide again.",
      ),
    ).toBeInTheDocument();
  });

  it("says when an action does not apply any more", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      accountDetail: vi.fn(async () => detail()),
      accountAction: vi.fn(async () => {
        throw accessApiError("admin.action_unavailable", 409);
      }),
    });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Relock access" }));
    await user.type(await screen.findByLabelText("Reason"), "Abuse report");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Relock access" }),
    );
    expect(
      await screen.findByText("That action doesn't apply to this account's current state."),
    ).toBeInTheDocument();
  });

  it("offers no access action for a suspended or deleting account", async () => {
    const { unmount } = renderAccess(<AccountDetail userId={mayaUserId} />, {
      api: createFakeAccessApi({
        accountDetail: vi.fn(async () => detail(adminAccountFixture({ suspendedAt: Date.now() }))),
      }),
      me: admin,
    });
    expect(await screen.findByText(/This account is suspended/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Relock|Unlock|Restore/ })).not.toBeInTheDocument();
    unmount();

    renderAccess(<AccountDetail userId={mayaUserId} />, {
      api: createFakeAccessApi({
        accountDetail: vi.fn(async () =>
          detail(adminAccountFixture({ deletionState: "deleting" })),
        ),
      }),
      me: admin,
    });
    expect(await screen.findByText(/This account is being deleted/)).toBeInTheDocument();
  });

  it("says plainly when the account does not exist", async () => {
    const api = createFakeAccessApi({
      accountDetail: vi.fn(async () => {
        throw accessApiError("not_found", 404);
      }),
    });
    renderAccess(<AccountDetail userId={mayaUserId} />, { api, me: admin });
    expect(await screen.findByRole("heading", { name: "Account not found" })).toBeInTheDocument();
  });
});
