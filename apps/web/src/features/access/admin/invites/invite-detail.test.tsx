import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessApiError,
  adminInviteFixture,
  campaignIdFixture,
  createFakeAccessApi,
  mayaMe,
  mayaUserId,
  renderAccess,
  stubNavigation,
} from "../../test-support.tsx";
import { InviteDetail } from "./invite-detail.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/invites/x",
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
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let location = stubNavigation("/admin/invites/x");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/admin/invites/x");
});

afterEach(() => {
  location.restore();
});

const admin = mayaMe({ user: { role: "admin" } as never });
const invite = adminInviteFixture();

const redemption = {
  id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e2001",
  seatNo: 1,
  userId: mayaUserId,
  email: "maya@example.com",
  displayName: "Maya Rao",
  accessEpoch: 0,
  redeemedAt: Date.UTC(2026, 8, 2, 10),
  grant: "current" as const,
};

function detail(overrides: Partial<ReturnType<typeof adminInviteFixture>> = {}) {
  return { invite: { ...invite, ...overrides }, redemptions: [redemption] };
}

describe("one invite (admin_invites.md)", () => {
  it("shows uses, remaining seats and the accounts that redeemed it", async () => {
    const api = createFakeAccessApi({ inviteDetail: vi.fn(async () => detail()) });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    expect(await screen.findByRole("heading", { name: "Friends — September" })).toBeInTheDocument();
    expect(screen.getByText(/1 of 5 seats used/)).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    const row = (await screen.findByText(/Maya Rao · maya@example.com/)).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByText("Current")).toBeInTheDocument();
    // Redemptions show identity and dates, never private content.
    expect(screen.queryByText(/task|document|vault/i)).not.toBeInTheDocument();
  });

  it("never lets a cap go below the seats already used", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => detail({ used: 2 })),
      updateInviteCapacity: vi.fn(),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Change capacity" }));
    const field = await screen.findByLabelText("Maximum redemptions");
    await user.clear(field);
    await user.type(field, "1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("The cap can't go below the 2 seats already used."),
    ).toBeInTheDocument();
    expect(api.updateInviteCapacity).not.toHaveBeenCalled();
  });

  it("raises the cap with the version it read", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => detail()),
      updateInviteCapacity: vi.fn(async () =>
        adminInviteFixture({ maxRedemptions: 8, version: 4 }),
      ),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Change capacity" }));
    const field = await screen.findByLabelText("Maximum redemptions");
    await user.clear(field);
    await user.type(field, "8");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateInviteCapacity).toHaveBeenCalledWith(
        invite.id,
        { maxRedemptions: 8, expectedVersion: 3 },
        expect.any(String),
      ),
    );
    expect(await screen.findByText("Capacity is now 8.")).toBeInTheDocument();
  });

  it("refuses a concurrent edit and offers a reload", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => detail()),
      updateInviteCapacity: vi.fn(async () => {
        throw accessApiError("invite.changed", 409);
      }),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Change capacity" }));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("This invite changed since you opened it. Reload it and try again."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload invite" }));
    await waitFor(() => expect(api.inviteDetail).toHaveBeenCalledTimes(2));
  });

  it("extends the expiry only to a later date", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => detail()),
      extendInviteExpiry: vi.fn(async () =>
        adminInviteFixture({ expiresAt: Date.UTC(2026, 9, 7, 12) }),
      ),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Extend expiry" }));
    const field = await screen.findByLabelText("New expiry date");
    // A date input takes a whole value, not keystrokes.
    fireEvent.change(field, { target: { value: "2026-08-01" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Choose a date later than the current expiry."),
    ).toBeInTheDocument();
    expect(api.extendInviteExpiry).not.toHaveBeenCalled();
  });

  it("revokes future redemptions and says admitted accounts keep their access", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => detail()),
      revokeInvite: vi.fn(async () =>
        adminInviteFixture({ status: "revoked", revokedAt: Date.UTC(2026, 8, 5, 12) }),
      ),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Revoke invite" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/People already admitted with it keep their access/);
    await user.click(within(dialog).getByRole("button", { name: "Revoke invite" }));
    expect(await screen.findByText("This code can no longer be redeemed.")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change capacity" })).toBeDisabled(),
    );
  });

  it("previews campaign revocation, lists the accounts and refuses a stale preview", async () => {
    const user = userEvent.setup();
    const preview = {
      campaignId: campaignIdFixture,
      label: "Friends — September",
      accounts: [
        {
          id: mayaUserId as never,
          email: "maya@example.com",
          displayName: "Maya Rao",
          grantId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e3001",
          grantedAt: Date.UTC(2026, 8, 2, 11),
        },
      ],
      previewDigest: "a".repeat(64),
    };
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => detail()),
      previewCampaignRevocation: vi.fn(async () => preview),
      confirmCampaignRevocation: vi.fn(async () => {
        throw accessApiError("admin.preview_stale", 409);
      }),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Revoke campaign access…" }));
    expect(await screen.findByText("1 account would lose access:")).toBeInTheDocument();
    expect(screen.getByText("Maya Rao")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Revoke access for 1" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Reason"), "Campaign ended");
    await user.click(screen.getByRole("button", { name: "Revoke access for 1" }));
    expect(
      await screen.findByText(/The accounts in this campaign changed since the preview/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview again" }));
    await waitFor(() => expect(api.previewCampaignRevocation).toHaveBeenCalledTimes(2));
  });

  it("confirms a campaign revocation and reports what changed", async () => {
    const user = userEvent.setup();
    const preview = {
      campaignId: campaignIdFixture,
      label: null,
      accounts: [
        {
          id: mayaUserId as never,
          email: "maya@example.com",
          displayName: null,
          grantId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e3001",
          grantedAt: Date.UTC(2026, 8, 2, 11),
        },
      ],
      previewDigest: "b".repeat(64),
    };
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => detail()),
      previewCampaignRevocation: vi.fn(async () => preview),
      confirmCampaignRevocation: vi.fn(async () => ({
        campaignId: campaignIdFixture,
        revoked: 1,
        unchanged: 0,
      })),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Revoke campaign access…" }));
    await user.type(await screen.findByLabelText("Reason"), "Campaign ended");
    await user.click(screen.getByRole("button", { name: "Revoke access for 1" }));
    expect(await screen.findByText("Campaign access revoked")).toBeInTheDocument();
    expect(api.confirmCampaignRevocation).toHaveBeenCalledWith(
      campaignIdFixture,
      { previewDigest: preview.previewDigest, reason: "Campaign ended" },
      expect.any(String),
    );
  });

  it("says plainly when the invite does not exist", async () => {
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => {
        throw accessApiError("not_found", 404);
      }),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    expect(await screen.findByRole("heading", { name: "Invite not found" })).toBeInTheDocument();
  });

  it("explains an invite nobody has used yet", async () => {
    const api = createFakeAccessApi({
      inviteDetail: vi.fn(async () => ({
        invite: adminInviteFixture({ used: 0 }),
        redemptions: [],
      })),
    });
    renderAccess(<InviteDetail inviteId={invite.id} />, { api, me: admin });
    expect(await screen.findByText(/No one has used this code yet/)).toBeInTheDocument();
  });
});
