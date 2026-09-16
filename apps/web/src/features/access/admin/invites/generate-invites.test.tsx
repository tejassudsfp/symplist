import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  adminInviteFixture,
  campaignIdFixture,
  createFakeAccessApi,
  mayaMe,
  renderAccess,
  stubNavigation,
} from "../../test-support.tsx";
import { toDateInputValue } from "../../ui/format.ts";
import { GenerateInvites } from "./generate-invites.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/invites/new",
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

let location = stubNavigation("/admin/invites/new");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/admin/invites/new");
});

afterEach(() => {
  location.restore();
});

const admin = mayaMe({ user: { role: "admin" } as never });
const code = "SYM-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6723";

function minted(codes: string[]) {
  return {
    secretUnavailable: false as const,
    campaignId: campaignIdFixture,
    invites: codes.map((_, index) =>
      adminInviteFixture({
        id: `01929f3e-7c1a-7b2e-9a55-3c2f1d0e10${index}0` as ReturnType<
          typeof adminInviteFixture
        >["id"],
      }),
    ),
    codes,
  };
}

describe("generating invite codes (admin_invite_create.md)", () => {
  it("defaults to one independent single-use code valid for seven days", async () => {
    renderAccess(<GenerateInvites />, { me: admin });
    expect(await screen.findByRole("heading", { name: "Generate codes" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Independent codes/ })).toBeChecked();
    expect(screen.getByLabelText("How many codes")).toHaveValue(1);
    expect(screen.getByLabelText("Redemptions per code")).toHaveValue(1);
    expect(screen.getByLabelText("Expires")).toHaveValue(
      toDateInputValue(Date.now() + 7 * 86_400_000),
    );
    // No distribution of any kind.
    expect(screen.queryByRole("button", { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/recipients/i)).not.toBeInTheDocument();
  });

  it("keeps the shared campaign code a separate, explicit choice", async () => {
    const user = userEvent.setup();
    renderAccess(<GenerateInvites />, { me: admin });
    await user.click(await screen.findByRole("radio", { name: /One shared campaign code/ }));
    expect(screen.queryByLabelText("How many codes")).not.toBeInTheDocument();
    expect(screen.getByLabelText("How many people may redeem it")).toBeInTheDocument();
  });

  it("explains the bound email under Advanced options and refuses it for a batch", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ generateInvites: vi.fn() });
    renderAccess(<GenerateInvites />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Advanced options" }));
    const bound = screen.getByLabelText("Bind to an email address");
    expect(screen.getByText(/Nothing is sent to it/)).toBeInTheDocument();
    await user.type(bound, "maya@example.com");
    const count = screen.getByLabelText("How many codes");
    await user.clear(count);
    await user.type(count, "5");
    await user.click(screen.getByRole("button", { name: "Generate codes" }));
    expect(await screen.findByText("A bound email applies to a single code.")).toBeInTheDocument();
    expect(api.generateInvites).not.toHaveBeenCalled();
  });

  it("refuses an expiry in the past or beyond a year", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ generateInvites: vi.fn() });
    renderAccess(<GenerateInvites />, { api, me: admin });
    fireEvent.change(await screen.findByLabelText("Expires"), { target: { value: "2020-01-01" } });
    await user.click(screen.getByRole("button", { name: "Generate codes" }));
    expect(await screen.findByText("Choose a date in the future.")).toBeInTheDocument();
    expect(api.generateInvites).not.toHaveBeenCalled();
  });

  it("shows one generated code once, with Copy and an explicit Done", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ generateInvites: vi.fn(async () => minted([code])) });
    renderAccess(<GenerateInvites />, { api, me: admin });
    await user.type(await screen.findByLabelText("Label or note"), "Friends — September");
    await user.click(screen.getByRole("button", { name: "Generate codes" }));
    expect(await screen.findByRole("heading", { name: "Your code" })).toBeInTheDocument();
    expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByText(/Save these now. Full codes won't be shown again/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(code));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(navigation.push).toHaveBeenCalledWith("/admin/invites");
  });

  it("copies a whole batch at once", async () => {
    const user = userEvent.setup();
    const second = "SYM-BCDE-FGHJ-KLMN-PQRS-TUVW-XYZ2-3456-7234";
    const api = createFakeAccessApi({ generateInvites: vi.fn(async () => minted([code, second])) });
    renderAccess(<GenerateInvites />, { api, me: admin });
    const count = await screen.findByLabelText("How many codes");
    await user.clear(count);
    await user.type(count, "2");
    await user.click(screen.getByRole("button", { name: "Generate codes" }));
    expect(await screen.findByRole("heading", { name: "Your 2 codes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy all codes" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(`${code}\n${second}`),
    );
  });

  it("says plainly when the clipboard refuses, leaving the code selectable", async () => {
    const user = userEvent.setup();
    const clipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    onTestFinished(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    });
    const api = createFakeAccessApi({ generateInvites: vi.fn(async () => minted([code])) });
    renderAccess(<GenerateInvites />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Generate codes" }));
    await user.click(await screen.findByRole("button", { name: "Copy code" }));
    expect(
      await screen.findByText(/The clipboard isn't available in this browser/),
    ).toBeInTheDocument();
    expect(screen.getByText(code)).toBeInTheDocument();
  });

  it("warns before leaving while the codes are still unacknowledged", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ generateInvites: vi.fn(async () => minted([code])) });
    renderAccess(
      <>
        <GenerateInvites />
        <a href="/admin/accounts">Somewhere else</a>
      </>,
      { api, me: admin },
    );
    await user.click(await screen.findByRole("button", { name: "Generate codes" }));
    await screen.findByText(code);
    await user.click(screen.getByRole("link", { name: "Somewhere else" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Leave before saving the codes?");
    await user.click(within(dialog).getByRole("button", { name: "Stay and copy" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText(code)).toBeInTheDocument();
  });

  it("lets an uncertain request be checked instead of issuing another batch", async () => {
    const user = userEvent.setup();
    let firstTry = true;
    const api = createFakeAccessApi({
      generateInvites: vi.fn(async () => {
        if (firstTry) {
          firstTry = false;
          throw new ApiNetworkError();
        }
        return minted([code]);
      }),
    });
    renderAccess(<GenerateInvites />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Generate codes" }));
    expect(await screen.findByText("We couldn't confirm the result")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check the result" }));
    expect(await screen.findByText(code)).toBeInTheDocument();
    const calls = (api.generateInvites as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // The check replays the same request with the same key, so nothing is created twice (§6.1).
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
  });

  it("explains a replayed batch whose codes can no longer be shown", async () => {
    const user = userEvent.setup();
    let firstTry = true;
    const api = createFakeAccessApi({
      generateInvites: vi.fn(async () => {
        if (firstTry) {
          firstTry = false;
          throw new ApiNetworkError();
        }
        return {
          secretUnavailable: true as const,
          notice: "secret.already_issued" as const,
          campaignId: campaignIdFixture,
          invites: [adminInviteFixture()],
        };
      }),
    });
    renderAccess(<GenerateInvites />, { api, me: admin });
    await user.click(await screen.findByRole("button", { name: "Generate codes" }));
    await user.click(await screen.findByRole("button", { name: "Check the result" }));
    expect(
      await screen.findByRole("heading", { name: "These codes were already created" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing was created twice")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review this batch" })).toHaveAttribute(
      "href",
      `/admin/invites?campaignId=${campaignIdFixture}`,
    );
    expect(screen.queryByText(/SYM(-[A-Z2-7]{4}){8}/)).not.toBeInTheDocument();
  });
});
