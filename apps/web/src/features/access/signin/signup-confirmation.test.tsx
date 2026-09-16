import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  accessApiError,
  createFakeAccessApi,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { SIGN_IN_FLOW_KEY, SignInFlowProvider } from "./flow.tsx";
import { SignupConfirmation } from "./signup-confirmation.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/signin/create",
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

let location = stubNavigation("/signin/create");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  window.sessionStorage.clear();
  window.sessionStorage.setItem(
    SIGN_IN_FLOW_KEY,
    JSON.stringify({ email: "maya@example.com", challenge: null }),
  );
  location = stubNavigation("/signin/create");
});

afterEach(() => {
  location.restore();
});

const challenge = {
  challengeId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001",
  purpose: "signup" as const,
  expiresAt: Date.now() + 600_000,
  resendAvailableAt: Date.now() + 60_000,
  codeLength: 6,
};

function renderConfirmation(api = createFakeAccessApi()) {
  return renderAccess(
    <SignInFlowProvider>
      <SignupConfirmation />
    </SignInFlowProvider>,
    { api },
  );
}

describe("signup confirmation (signup_confirmation.md)", () => {
  it("shows the address, the two actions and the invite reminder", async () => {
    renderConfirmation();
    expect(await screen.findByRole("heading", { name: "No account found" })).toBeInTheDocument();
    expect(screen.getByText("maya@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use another email" })).toBeInTheDocument();
    expect(screen.getByText(/signing up never sends one/)).toBeInTheDocument();
  });

  it("creates the pending account only on an explicit confirmation", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ signup: vi.fn(async () => challenge) });
    renderConfirmation(api);
    await screen.findByRole("button", { name: "Create account" });
    expect(api.signup).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/signin/verify"));
    expect(api.signup).toHaveBeenCalledWith("maya@example.com");
  });

  it("reports progress while the account is being created", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const api = createFakeAccessApi({
      signup: vi.fn(
        () =>
          new Promise<typeof challenge>((resolve) => {
            release = () => resolve(challenge);
          }),
      ),
    });
    renderConfirmation(api);
    await user.click(await screen.findByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("button", { name: "Creating account…" })).toBeDisabled();
    release();
    await waitFor(() => expect(navigation.push).toHaveBeenCalled());
  });

  it("offers a plain retry when the verification email could not be sent", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      signup: vi.fn(async () => {
        throw accessApiError("auth.delivery_failed", 502);
      }),
    });
    renderConfirmation(api);
    await user.click(await screen.findByRole("button", { name: "Create account" }));
    expect(await screen.findByText("We couldn't send the code")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your account is waiting for verification, and nothing was sent. Try again.",
      ),
    ).toBeInTheDocument();
    // The retry never implies a second account.
    expect(screen.getByRole("button", { name: "Send the code again" })).toBeInTheDocument();
  });

  it("continues with a sign-in code when the address turns out to exist", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      signup: vi.fn(async () => {
        throw accessApiError("auth.account_exists", 409);
      }),
      sendLoginCode: vi.fn(async () => ({ ...challenge, purpose: "login" as const })),
    });
    renderConfirmation(api);
    await user.click(await screen.findByRole("button", { name: "Create account" }));
    expect(await screen.findByText("This email already has an account")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send a sign-in code" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/signin/verify"));
    expect(api.sendLoginCode).toHaveBeenCalledWith("maya@example.com");
  });

  it("returns to editable email entry without creating anything", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ signup: vi.fn() });
    renderConfirmation(api);
    await user.click(await screen.findByRole("button", { name: "Use another email" }));
    expect(navigation.push).toHaveBeenCalledWith("/signin");
    expect(api.signup).not.toHaveBeenCalled();
  });

  it("dismisses with Escape, back to email entry", async () => {
    const user = userEvent.setup();
    renderConfirmation();
    await screen.findByRole("heading", { name: "No account found" });
    await user.keyboard("{Escape}");
    expect(navigation.push).toHaveBeenCalledWith("/signin");
  });

  it("explains a network failure and keeps the confirmation open", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      signup: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderConfirmation(api);
    await user.click(await screen.findByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText("Symplist couldn't be reached. Check your connection and try again."),
    ).toBeInTheDocument();
  });

  it("stays on the confirmation after a reload, while session storage is still being read", async () => {
    renderConfirmation();
    expect(await screen.findByRole("heading", { name: "No account found" })).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalledWith("/signin");
  });

  it("returns to email entry when no address was carried here", async () => {
    window.sessionStorage.clear();
    renderConfirmation();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/signin"));
  });
});
