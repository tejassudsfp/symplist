import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  accessApiError,
  createFakeAccessApi,
  mayaMe,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { EmailEntry } from "./email-entry.tsx";
import { SignInFlowProvider } from "./flow.tsx";

const navigation = vi.hoisted(() => ({ pathname: "/signin", push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

let location = stubNavigation("/signin");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  window.sessionStorage.clear();
  location = stubNavigation("/signin");
});

afterEach(() => {
  location.restore();
});

const challenge = {
  challengeId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001",
  purpose: "login" as const,
  expiresAt: Date.now() + 600_000,
  resendAvailableAt: Date.now() + 60_000,
  codeLength: 6,
};

function renderEntry(api = createFakeAccessApi()) {
  return renderAccess(
    <SignInFlowProvider>
      <EmailEntry />
    </SignInFlowProvider>,
    { api },
  );
}

describe("email entry (email_entry.md)", () => {
  it("shows one field, Continue and the closed-beta note, with no password or invite field", async () => {
    renderEntry();
    expect(await screen.findByRole("heading", { name: "Sign in to Symplist" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByText(/Closed beta\./)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/invite/i)).not.toBeInTheDocument();
  });

  it("refuses an address that is not an email and keeps what was typed", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ lookup: vi.fn() });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Enter an email address, for example maya@example.com"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("maya@");
    expect(api.lookup).not.toHaveBeenCalled();
  });

  it("sends a sign-in code for a known address and moves to verification", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      lookup: vi.fn(async () => ({ exists: true })),
      sendLoginCode: vi.fn(async () => challenge),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "Maya@Example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/signin/verify"));
    // The address is normalized before it reaches the api (§4.3).
    expect(api.lookup).toHaveBeenCalledWith("maya@example.com");
    expect(api.sendLoginCode).toHaveBeenCalledWith("maya@example.com");
  });

  it("asks for signup permission for an unknown address instead of creating an account", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      lookup: vi.fn(async () => ({ exists: false })),
      signup: vi.fn(),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/signin/create"));
    expect(api.signup).not.toHaveBeenCalled();
  });

  it("reports progress without claiming a code was sent", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const api = createFakeAccessApi({
      lookup: vi.fn(
        () =>
          new Promise<{ exists: boolean }>((resolve) => {
            release = () => resolve({ exists: false });
          }),
      ),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const button = await screen.findByRole("button", { name: "Checking…" });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.queryByText(/we sent/i)).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(navigation.push).toHaveBeenCalled());
  });

  it("keeps the address and offers a retry when the email service fails", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      lookup: vi.fn(async () => ({ exists: true })),
      sendLoginCode: vi.fn(async () => {
        throw accessApiError("auth.delivery_failed", 502);
      }),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("We couldn't send the code")).toBeInTheDocument();
    expect(screen.getByText("Nothing was sent. Try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("maya@example.com");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("shows the wait when the address is throttled and blocks Continue until it passes", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      lookup: vi.fn(async () => {
        throw accessApiError("rate.limited", 503, { retryAfterSeconds: 120 });
      }),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Too many tries")).toBeInTheDocument();
    expect(screen.getByText(/Wait 2 minutes before asking for another code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("says plainly when the account is being deleted", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      lookup: vi.fn(async () => ({ exists: true })),
      sendLoginCode: vi.fn(async () => {
        throw accessApiError("auth.account_unavailable", 409);
      }),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("This account is being deleted")).toBeInTheDocument();
  });

  it("offers account creation when the account disappeared between the two steps", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      lookup: vi.fn(async () => ({ exists: true })),
      sendLoginCode: vi.fn(async () => {
        throw accessApiError("auth.account_not_found", 404);
      }),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Create an account" }));
    expect(navigation.push).toHaveBeenCalledWith("/signin/create");
  });

  it("explains a network failure without losing the address", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      lookup: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderEntry(api);
    await user.type(screen.getByLabelText("Email"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Symplist couldn't be reached. Check your connection and try again."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("maya@example.com");
  });

  it("explains an expired session and a finished deletion when the address says so", async () => {
    location.setPath("/signin?expired=1");
    const { unmount } = renderEntry();
    expect(
      await screen.findByText(
        /Your session has ended. Sign in again to pick up where you left off./,
      ),
    ).toBeInTheDocument();
    unmount();
    location.setPath("/signin?deleted=1");
    renderEntry();
    expect(await screen.findByText("Your account has been deleted")).toBeInTheDocument();
  });

  it("opens the account instead of the form when a session is already signed in", async () => {
    renderEntry(createFakeAccessApi());
    const { unmount } = renderAccess(
      <SignInFlowProvider>
        <EmailEntry />
      </SignInFlowProvider>,
      { me: mayaMe() },
    );
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/now"));
    unmount();
  });
});
