import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  accessApiError,
  adminInviteFixture,
  createFakeAccessApi,
  mayaMe,
  renderAccess,
  stubNavigation,
} from "../../test-support.tsx";
import { InviteInventory } from "./invite-inventory.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/invites",
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

let location = stubNavigation("/admin/invites");

beforeEach(() => {
  navigation.search = "";
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/admin/invites");
});

afterEach(() => {
  location.restore();
});

const admin = mayaMe({ user: { role: "admin" } as never });

function page(items = [adminInviteFixture()], nextCursor: string | null = null) {
  return { items, nextCursor };
}

describe("the invite inventory (admin_invites.md)", () => {
  it("lists label, hint, status, use, expiry and creation date, and never a full code", async () => {
    const api = createFakeAccessApi({ listInvites: vi.fn(async () => page()) });
    renderAccess(<InviteInventory />, { api, me: admin });
    expect(await screen.findByRole("heading", { name: "Invites" })).toBeInTheDocument();
    const row = (await screen.findByText("Friends — September")).closest("tr") as HTMLElement;
    expect(within(row).getByText("SYM-…-WXYZ")).toBeInTheDocument();
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("1 of 5")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /View Friends/ })).toHaveAttribute(
      "href",
      `/admin/invites/${adminInviteFixture().id}`,
    );
    // Only the hint is shown; a full code is never recoverable here.
    expect(screen.queryByText(/SYM(-[A-Z2-7]{4}){8}/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset usage/i })).not.toBeInTheDocument();
  });

  it("shows a region-level loading state, then the rows", async () => {
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    const api = createFakeAccessApi({
      listInvites: vi.fn(
        () =>
          new Promise<ReturnType<typeof page>>((resolve) => {
            release = resolve;
          }),
      ),
    });
    renderAccess(<InviteInventory />, { api, me: admin });
    expect(await screen.findByText("Loading invites")).toBeInTheDocument();
    release(page());
    expect(await screen.findByText("Friends — September")).toBeInTheDocument();
  });

  it("explains an empty inventory and a filtered search with no matches", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ listInvites: vi.fn(async () => page([])) });
    renderAccess(<InviteInventory />, { api, me: admin });
    expect(await screen.findByText("No invites yet")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Search invites/), "design");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No invites match these filters")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.listInvites).toHaveBeenCalledWith({ q: "design" }, expect.anything()),
    );
  });

  it("reports a failed load with a retry", async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = createFakeAccessApi({
      listInvites: vi.fn(async () => {
        if (fail) throw new ApiNetworkError();
        return page();
      }),
    });
    renderAccess(<InviteInventory />, { api, me: admin });
    expect(await screen.findByText("Couldn't load invites")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Friends — September")).toBeInTheDocument();
  });

  it("filters by status and keeps the filter in the address", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ listInvites: vi.fn(async () => page()) });
    renderAccess(<InviteInventory />, { api, me: admin });
    await screen.findByText("Friends — September");
    await user.click(screen.getByRole("button", { name: "Revoked" }));
    await waitFor(() =>
      expect(api.listInvites).toHaveBeenCalledWith({ status: "revoked" }, expect.anything()),
    );
    expect(navigation.replace).toHaveBeenCalledWith("/admin/invites?status=revoked");
  });

  it("loads another page with the opaque cursor", async () => {
    const user = userEvent.setup();
    const second = adminInviteFixture({
      id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e1002" as ReturnType<typeof adminInviteFixture>["id"],
      label: "Design feedback",
    });
    const api = createFakeAccessApi({
      listInvites: vi.fn(async (query) =>
        query.cursor ? page([second]) : page([adminInviteFixture()], "cursor-2"),
      ),
    });
    renderAccess(<InviteInventory />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Design feedback")).toBeInTheDocument();
    expect(screen.getByText("Friends — September")).toBeInTheDocument();
  });

  it("previews a batch revocation before it runs and explains what it does not do", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listInvites: vi.fn(async () => page()),
      revokeInvite: vi.fn(async () =>
        adminInviteFixture({ status: "revoked", revokedAt: Date.now() }),
      ),
    });
    renderAccess(<InviteInventory />, { api, me: admin });
    await user.click(await screen.findByRole("checkbox", { name: /Select invite SYM-…-WXYZ/ }));
    await user.click(screen.getByRole("button", { name: "Revoke selected" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Friends — September");
    expect(dialog).toHaveTextContent(/People already admitted with them keep their access/);
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(api.revokeInvite).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Revocation finished")).toBeInTheDocument();
    const [, body] =
      (api.revokeInvite as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
    expect(body).toEqual({ expectedVersion: 3 });
  });

  it("counts an invite that changed since it was listed as unchanged", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      listInvites: vi.fn(async () => page()),
      revokeInvite: vi.fn(async () => {
        throw accessApiError("invite.changed", 409);
      }),
    });
    renderAccess(<InviteInventory />, { api, me: admin });
    await user.click(await screen.findByRole("checkbox", { name: /Select invite/ }));
    await user.click(screen.getByRole("button", { name: "Revoke selected" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }),
    );
    expect(await screen.findByText(/already revoked or changed/)).toBeInTheDocument();
  });

  it("narrows to one campaign when the address names one", async () => {
    navigation.search = "campaignId=01929f3e-7c1a-7b2e-9a55-3c2f1d0ec001";
    const api = createFakeAccessApi({ listInvites: vi.fn(async () => page()) });
    renderAccess(<InviteInventory />, { api, me: admin });
    await waitFor(() =>
      expect(api.listInvites).toHaveBeenCalledWith(
        { campaignId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0ec001" },
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/Showing one campaign only/)).toBeInTheDocument();
  });
});
