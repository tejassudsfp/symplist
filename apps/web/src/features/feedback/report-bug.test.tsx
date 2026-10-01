import type { BugReportReceipt } from "@symplist/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@/features/access/session";
import { ApiError } from "@/lib/api";
import type { FeedbackApi } from "./api.ts";
import { ReportBugButton, ReportBugDialog } from "./report-bug.tsx";

const receipt: BugReportReceipt = {
  id: "0199a1b2-0000-7000-8000-000000000001",
  createdAt: 1_789_500_000_000,
};

function fakeApi(overrides: Partial<FeedbackApi> = {}): FeedbackApi {
  return {
    report: vi.fn(async () => receipt),
    reportAnonymously: vi.fn(async () => receipt),
    ...overrides,
  };
}

function renderDialog(
  api: FeedbackApi,
  options: { readonly signedIn?: boolean } = {},
): { readonly user: ReturnType<typeof userEvent.setup> } {
  // Only `status` matters here: the dialog asks whether there is a session, never who it belongs to.
  const session = options.signedIn
    ? ({ status: "signed_in" } as const)
    : ({ status: "signed_out" } as const);
  render(
    <SessionProvider value={session}>
      <ReportBugDialog open onOpenChange={() => undefined} api={api} />
    </SessionProvider>,
  );
  return { user: userEvent.setup() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reporting a bug", () => {
  it("files an attributed report with the page, and confirms it", async () => {
    const api = fakeApi();
    const { user } = renderDialog(api, { signedIn: true });
    const dialog = await screen.findByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send report" });
    expect(send).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText("What happened"),
      "  Archiving blanked the page  ",
    );
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(api.report).toHaveBeenCalledTimes(1));
    expect(api.report).toHaveBeenCalledWith({
      report: "Archiving blanked the page",
      surface: "workspace",
      page: "/",
    });
    expect(api.reportAnonymously).not.toHaveBeenCalled();
    expect(await screen.findByText("Report sent")).toBeInTheDocument();
  });

  it("files a visitor's report through the public route, bound to nobody", async () => {
    const api = fakeApi();
    const { user } = renderDialog(api);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What happened"), "Sign in did nothing");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(api.reportAnonymously).toHaveBeenCalledTimes(1));
    expect(api.reportAnonymously).toHaveBeenCalledWith({
      report: "Sign in did nothing",
      surface: "site",
      page: "/",
    });
    expect(api.report).not.toHaveBeenCalled();
  });

  it("keeps what was typed when the report fails, and sends it on the retry", async () => {
    const report = vi
      .fn<FeedbackApi["report"]>()
      .mockRejectedValueOnce(
        new ApiError({
          status: 503,
          code: "rate.limited",
          message: "Too many requests; try again later",
          requestId: "req_1",
        }),
      )
      .mockResolvedValueOnce(receipt);
    const api = fakeApi({ report });
    const { user } = renderDialog(api, { signedIn: true });
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What happened"), "Reminders fire twice");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/wait a few minutes/i);
    // Nothing was lost: the box still holds the words, and the button still offers to send them.
    expect(within(dialog).getByLabelText("What happened")).toHaveValue("Reminders fire twice");

    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Report sent")).toBeInTheDocument();
  });

  it("reports the desktop surface and its version when the shell is there", async () => {
    vi.stubGlobal("symplist", {
      cloud: { apiOrigin: "https://api.symplist.test", fetch: async () => undefined },
      host: { info: async () => ({ runtime: "desktop", appVersion: "0.0.1", platform: "darwin" }) },
    });
    const api = fakeApi();
    const { user } = renderDialog(api, { signedIn: true });
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What happened"), "The window reopened empty");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(api.report).toHaveBeenCalledTimes(1));
    expect((api.report as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      report: "The window reopened empty",
      surface: "desktop",
      page: "/",
      appVersion: "0.0.1",
      platform: "darwin",
    });
  });

  it("opens from a self-contained control, which is all a footer has to mount", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(
      <SessionProvider value={{ status: "signed_out" }}>
        <ReportBugButton api={api} />
      </SessionProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Report a bug" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
