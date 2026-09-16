import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  accessApiError,
  createFakeAccessApi,
  lockedAccess,
  mayaMe,
  pausedAccess,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { SIGN_IN_FLOW_KEY, SignInFlowProvider } from "./flow.tsx";
import { VerifyCode } from "./verify-code.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/signin/verify",
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

let location = stubNavigation("/signin/verify");

const challengeId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001";

function storeChallenge(overrides: Partial<Record<string, unknown>> = {}) {
  window.sessionStorage.setItem(
    SIGN_IN_FLOW_KEY,
    JSON.stringify({
      email: "maya@example.com",
      challenge: {
        email: "maya@example.com",
        challengeId,
        purpose: "login",
        expiresAt: Date.now() + 600_000,
        resendAvailableAt: Date.now() - 1_000,
        codeLength: 6,
        ...overrides,
      },
    }),
  );
}

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  window.sessionStorage.clear();
  storeChallenge();
  location = stubNavigation("/signin/verify");
});

afterEach(() => {
  location.restore();
});

function renderVerify(api = createFakeAccessApi()) {
  return renderAccess(
    <SignInFlowProvider>
      <VerifyCode />
    </SignInFlowProvider>,
    { api },
  );
}

const codeLabel = "6-digit code";

describe("email verification (email_otp.md)", () => {
  it("shows the destination address, an Edit email action and one code field", async () => {
    renderVerify();
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByText("maya@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit email" })).toBeInTheDocument();
    const input = screen.getByLabelText(codeLabel);
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
  });

  it("verifies a full code and routes by the account's access state", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      verifyCode: vi.fn(async () => mayaMe({ access: lockedAccess })),
    });
    renderVerify(api);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    await waitFor(() => expect(api.verifyCode).toHaveBeenCalledWith(challengeId, "123456"));
    // A verified but locked account reaches the beta gate, never the app (note 03).
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/access"));
  });

  it("takes an admitted account into the app and forgets the flow", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ verifyCode: vi.fn(async () => mayaMe()) });
    renderVerify(api);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/now"));
    const stored = window.sessionStorage.getItem(SIGN_IN_FLOW_KEY);
    expect(stored === null ? null : JSON.parse(stored).challenge).toBeNull();
  });

  it("sends a paused account to the paused screen", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      verifyCode: vi.fn(async () => mayaMe({ access: pausedAccess })),
    });
    renderVerify(api);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/access/paused"));
  });

  it("accepts a pasted code with spaces and keeps only the digits", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ verifyCode: vi.fn(async () => mayaMe()) });
    renderVerify(api);
    const input = await screen.findByLabelText(codeLabel);
    input.focus();
    await user.paste("123 456");
    await waitFor(() => expect(api.verifyCode).toHaveBeenCalledWith(challengeId, "123456"));
  });

  it("counts the tries left on a wrong code and clears the field", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      verifyCode: vi.fn(async () => {
        throw accessApiError("otp.incorrect", 400, { details: { attemptsRemaining: 3 } });
      }),
    });
    renderVerify(api);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    expect(
      await screen.findByText("That code isn't right. 3 tries left before you need a new code."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(codeLabel)).toHaveValue("");
  });

  it("offers a new code when the one entered expired", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      verifyCode: vi.fn(async () => {
        throw accessApiError("otp.expired", 410);
      }),
      sendLoginCode: vi.fn(async () => ({
        challengeId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0002",
        purpose: "login" as const,
        expiresAt: Date.now() + 600_000,
        resendAvailableAt: Date.now() + 60_000,
        codeLength: 6,
      })),
    });
    renderVerify(api);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    expect(await screen.findByText("That code has expired")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(
      await screen.findByText("We sent a new code to maya@example.com. Enter the newest one."),
    ).toBeInTheDocument();
    expect(api.sendLoginCode).toHaveBeenCalledWith("maya@example.com");
  });

  it("explains an exhausted code and a locked address without alarm", async () => {
    const user = userEvent.setup();
    const exhausted = createFakeAccessApi({
      verifyCode: vi.fn(async () => {
        throw accessApiError("otp.attempts_exhausted", 410);
      }),
    });
    const { unmount } = renderVerify(exhausted);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    expect(await screen.findByText("Too many tries with this code")).toBeInTheDocument();
    unmount();

    storeChallenge();
    const locked = createFakeAccessApi({
      verifyCode: vi.fn(async () => {
        throw accessApiError("otp.locked", 429, { retryAfterSeconds: 3600 });
      }),
    });
    renderVerify(locked);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    expect(await screen.findByText("Too many attempts for this address")).toBeInTheDocument();
    expect(screen.getByText(/verification is paused for about an hour/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeDisabled();
  });

  it("counts down the resend cooldown and enables it afterwards", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      storeChallenge({ resendAvailableAt: Date.now() + 3_000 });
      renderVerify();
      expect(
        await screen.findByRole("button", { name: /Send a new code in 0:0\d/ }),
      ).toBeDisabled();
      await vi.advanceTimersByTimeAsync(3_500);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the code when Symplist cannot be reached", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      verifyCode: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderVerify(api);
    await user.type(await screen.findByLabelText(codeLabel), "123456");
    expect(
      await screen.findByText(
        "Symplist couldn't be reached. Your code is still valid — try again.",
      ),
    ).toBeInTheDocument();
  });

  it("reports a resend whose delivery failed", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      sendLoginCode: vi.fn(async () => {
        throw accessApiError("auth.delivery_failed", 502);
      }),
    });
    renderVerify(api);
    await user.click(await screen.findByRole("button", { name: "Send a new code" }));
    expect(await screen.findByText("We couldn't send the code")).toBeInTheDocument();
  });

  it("says that a code never unlocks beta access", async () => {
    renderVerify();
    expect(await screen.findByText(/they never unlock beta\s+access/)).toBeInTheDocument();
  });

  it("returns to email entry when there is no challenge", async () => {
    window.sessionStorage.clear();
    renderVerify();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/signin"));
  });

  it("edits the email by going back to entry with the challenge dropped", async () => {
    const user = userEvent.setup();
    renderVerify();
    await user.click(await screen.findByRole("button", { name: "Edit email" }));
    expect(navigation.push).toHaveBeenCalledWith("/signin");
  });

  it("verifies a signup code with the signup wording and resends through signup", async () => {
    const user = userEvent.setup();
    storeChallenge({ purpose: "signup" });
    const api = createFakeAccessApi({
      signup: vi.fn(async () => ({
        challengeId,
        purpose: "signup" as const,
        expiresAt: Date.now() + 600_000,
        resendAvailableAt: Date.now() + 60_000,
        codeLength: 6,
      })),
    });
    renderVerify(api);
    expect(
      await screen.findByText(
        /Verifying confirms who you are; opening the app still needs an invite/,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send a new code" }));
    await waitFor(() => expect(api.signup).toHaveBeenCalledWith("maya@example.com"));
  });
});
