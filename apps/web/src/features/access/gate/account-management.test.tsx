import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import { resetSignOutForTests } from "../sign-out.ts";
import {
  accessApiError,
  createFakeAccessApi,
  lockedAccess,
  mayaMe,
  pausedAccess,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { RestrictedAccountManagement } from "./account-management.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/access/account",
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

let location = stubNavigation("/access/account");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  resetSignOutForTests();
  location = stubNavigation("/access/account");
});

afterEach(() => {
  location.restore();
});

const challenge = {
  challengeId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001",
  purpose: "account_delete" as const,
  expiresAt: Date.now() + 600_000,
  resendAvailableAt: Date.now() + 60_000,
  codeLength: 6,
};

const authorization = {
  authorizationId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0002",
  expiresAt: Date.now() + 600_000,
};

describe("restricted account management (settings_account.md)", () => {
  it("shows identity and the permitted actions only, with no protected navigation", async () => {
    renderAccess(<RestrictedAccountManagement />, { me: mayaMe({ access: lockedAccess }) });
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.getByText("maya@example.com")).toBeInTheDocument();
    expect(screen.getByText("Waiting for an invite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delete this account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Connections/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Vault/ })).not.toBeInTheDocument();
  });

  it("names the paused state and returns to the paused screen", async () => {
    const user = userEvent.setup();
    renderAccess(<RestrictedAccountManagement />, { me: mayaMe({ access: pausedAccess }) });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to access" }));
    expect(navigation.replace).toHaveBeenCalledWith("/access/paused");
  });

  it("deletes the account only after a confirmation and a fresh emailed code", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      sendDeletionCode: vi.fn(async () => challenge),
      verifyDeletionCode: vi.fn(async () => authorization),
      requestDeletion: vi.fn(async () => ({ status: "deleting" as const })),
    });
    renderAccess(<RestrictedAccountManagement />, { api, me: mayaMe({ access: lockedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/tasks, pages, document history, conversations, vault items/);
    expect(api.sendDeletionCode).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send confirmation code" }));

    expect(await screen.findByLabelText("Confirmation code")).toBeInTheDocument();
    expect(api.sendDeletionCode).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText("Confirmation code"), "123456");
    await waitFor(() =>
      expect(api.verifyDeletionCode).toHaveBeenCalledWith(challenge.challengeId, "123456"),
    );

    expect(await screen.findByText("Ready to delete")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete my account permanently" }));
    await waitFor(() =>
      expect(api.requestDeletion).toHaveBeenCalledWith(
        authorization.authorizationId,
        expect.stringMatching(/[0-9a-f-]{20,}/),
      ),
    );
    await waitFor(() => expect(location.assign).toHaveBeenCalledWith("/signin?deleted=1"));
  });

  it("starts again when the confirmation expired, without deleting anything", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      sendDeletionCode: vi.fn(async () => challenge),
      verifyDeletionCode: vi.fn(async () => authorization),
      requestDeletion: vi.fn(async () => {
        throw accessApiError("account.deletion_unauthorized", 403);
      }),
    });
    renderAccess(<RestrictedAccountManagement />, { api, me: mayaMe({ access: lockedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    await user.click(await screen.findByRole("button", { name: "Send confirmation code" }));
    await user.type(await screen.findByLabelText("Confirmation code"), "123456");
    await user.click(await screen.findByRole("button", { name: "Delete my account permanently" }));
    expect(await screen.findByText("That confirmation has expired")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing was deleted. Start again to get a new code."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete account" })).toBeInTheDocument();
    expect(location.assign).not.toHaveBeenCalled();
  });

  it("keeps the account when the code is wrong", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      sendDeletionCode: vi.fn(async () => challenge),
      verifyDeletionCode: vi.fn(async () => {
        throw accessApiError("otp.incorrect", 400, { details: { attemptsRemaining: 2 } });
      }),
      requestDeletion: vi.fn(),
    });
    renderAccess(<RestrictedAccountManagement />, { api, me: mayaMe({ access: lockedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    await user.click(await screen.findByRole("button", { name: "Send confirmation code" }));
    await user.type(await screen.findByLabelText("Confirmation code"), "000000");
    expect(
      await screen.findByText("That code isn't right. 2 tries left before you need a new code."),
    ).toBeInTheDocument();
    expect(api.requestDeletion).not.toHaveBeenCalled();
  });

  it("says nothing was deleted when Symplist could not be reached", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      sendDeletionCode: vi.fn(async () => challenge),
      verifyDeletionCode: vi.fn(async () => authorization),
      requestDeletion: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderAccess(<RestrictedAccountManagement />, { api, me: mayaMe({ access: lockedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    await user.click(await screen.findByRole("button", { name: "Send confirmation code" }));
    await user.type(await screen.findByLabelText("Confirmation code"), "123456");
    await user.click(await screen.findByRole("button", { name: "Delete my account permanently" }));
    expect(
      await screen.findByText("Symplist couldn't be reached, so nothing was deleted. Try again."),
    ).toBeInTheDocument();
    expect(location.assign).not.toHaveBeenCalled();
  });

  it("reports a code that could not be sent", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      sendDeletionCode: vi.fn(async () => {
        throw accessApiError("auth.delivery_failed", 502);
      }),
    });
    renderAccess(<RestrictedAccountManagement />, { api, me: mayaMe({ access: lockedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    await user.click(await screen.findByRole("button", { name: "Send confirmation code" }));
    expect(await screen.findByText("We couldn't send the code")).toBeInTheDocument();
  });

  it("can be cancelled at the confirmation without sending anything", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ sendDeletionCode: vi.fn() });
    renderAccess(<RestrictedAccountManagement />, { api, me: mayaMe({ access: lockedAccess }) });
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    await user.click(await screen.findByRole("button", { name: "Keep my account" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.sendDeletionCode).not.toHaveBeenCalled();
  });
});
