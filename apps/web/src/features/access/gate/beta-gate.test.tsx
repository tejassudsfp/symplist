import { formatInviteCode } from "@symplist/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import { SessionStore } from "../session-store.ts";
import {
  accessApiError,
  admittedAccess,
  createFakeAccessApi,
  lockedAccess,
  mayaMe,
  pausedAccess,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { BetaGate } from "./beta-gate.tsx";

const navigation = vi.hoisted(() => ({ pathname: "/access", push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

let location = stubNavigation("/access");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/access");
});

afterEach(() => {
  location.restore();
});

/** A Base32 code (RFC 4648: letters plus 2 to 7), as an operator would paste it. */
const canonical = "ABCDEFGHJKLMNPQRSTUVWXYZ23456723";
const code = formatInviteCode(canonical);

function renderGate(api = createFakeAccessApi(), me = mayaMe({ access: lockedAccess })) {
  return renderAccess(<BetaGate />, { api, me });
}

describe("the beta gate (beta_gate.md)", () => {
  it("shows the signed-in state, one code field and no way to request a code", async () => {
    renderGate();
    expect(await screen.findByRole("heading", { name: "You're signed in" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Symplist is in closed beta. Enter an invite code shared with you to unlock your account.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Invite code")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Unlock account" })).toBeDisabled();
    expect(screen.getByText(/Don't have a code\?/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send me a code/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/waitlist/i)).not.toBeInTheDocument();
    // Nothing protected renders behind the gate.
    expect(screen.queryByRole("navigation", { name: "Collections" })).not.toBeInTheDocument();
  });

  it("groups a pasted code and unlocks the account", async () => {
    const user = userEvent.setup();
    const unlocked = mayaMe({ access: { ...admittedAccess, onboardingStep: "name" } });
    const api = createFakeAccessApi({
      redeem: vi.fn(async () => ({ outcome: "unlocked" as const, me: unlocked })),
    });
    renderGate(api);
    const field = await screen.findByLabelText("Invite code");
    field.focus();
    await user.paste(canonical.toLowerCase());
    expect(field).toHaveValue(code);
    await user.click(screen.getByRole("button", { name: "Unlock account" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/welcome"));
    const [sent, key] =
      (api.redeem as unknown as { mock: { calls: string[][] } }).mock.calls[0] ?? [];
    expect(sent).toBe(code);
    expect(key).toMatch(/[0-9a-f-]{20,}/);
  });

  it("reports redeeming without claiming success", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const api = createFakeAccessApi({
      redeem: vi.fn(
        () =>
          new Promise<never>(() => {
            release = () => undefined;
          }),
      ),
    });
    renderGate(api);
    const field = await screen.findByLabelText("Invite code");
    await user.type(field, code);
    await user.click(screen.getByRole("button", { name: "Unlock account" }));
    expect(await screen.findByRole("button", { name: "Unlocking…" })).toBeDisabled();
    expect(screen.queryByText(/Access unlocked/)).not.toBeInTheDocument();
    release();
  });

  it("gives one generic answer for invalid, expired, exhausted and bound codes", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      redeem: vi.fn(async () => {
        throw accessApiError("invite.invalid", 422);
      }),
    });
    renderGate(api);
    await user.type(await screen.findByLabelText("Invite code"), code);
    await user.click(screen.getByRole("button", { name: "Unlock account" }));
    expect(await screen.findByText("That code can't be used")).toBeInTheDocument();
    // Never says which reason, and never names another address.
    expect(
      screen.getByText(/It may be mistyped, already used, expired, withdrawn/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toHaveTextContent("bound");
  });

  it("keeps the code after a network failure so the same attempt can be retried", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      redeem: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderGate(api);
    const field = await screen.findByLabelText("Invite code");
    await user.type(field, code);
    await user.click(screen.getByRole("button", { name: "Unlock account" }));
    expect(
      await screen.findByText("Symplist couldn't be reached. Your code is still here — try again."),
    ).toBeInTheDocument();
    expect(field).toHaveValue(code);
    await user.click(screen.getByRole("button", { name: "Unlock account" }));
    const calls = (api.redeem as unknown as { mock: { calls: string[][] } }).mock.calls;
    // The retry reuses the idempotency key, so a lost answer can never take a second seat (§6.1).
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
  });

  it("shows the wait when redemptions are throttled", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      redeem: vi.fn(async () => {
        throw accessApiError("rate.limited", 503, { retryAfterSeconds: 90 });
      }),
    });
    renderGate(api);
    await user.type(await screen.findByLabelText("Invite code"), code);
    await user.click(screen.getByRole("button", { name: "Unlock account" }));
    expect(await screen.findByText("Too many tries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock account" })).toBeDisabled();
  });

  it("moves a relocked account to paused access instead of letting a code bypass it", async () => {
    const user = userEvent.setup();
    let identity = mayaMe({ access: lockedAccess });
    const store = new SessionStore({ me: async () => identity });
    const api = createFakeAccessApi({
      redeem: vi.fn(async () => {
        identity = mayaMe({ access: pausedAccess });
        throw accessApiError("access.relocked", 403);
      }),
    });
    renderAccess(<BetaGate />, { api, me: identity, store });
    await user.type(await screen.findByLabelText("Invite code"), code);
    await user.click(screen.getByRole("button", { name: "Unlock account" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/access/paused"));
  });

  it("checks access without sending anything and says when nothing changed", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ redeem: vi.fn() });
    renderGate(api);
    await user.click(await screen.findByRole("button", { name: "Check access" }));
    expect(
      await screen.findByText("No change yet — your account is still waiting for an invite code."),
    ).toBeInTheDocument();
    expect(api.redeem).not.toHaveBeenCalled();
  });

  it("picks up an administrator's unlock through Check access", async () => {
    const user = userEvent.setup();
    let identity = mayaMe({ access: lockedAccess });
    const store = new SessionStore({ me: async () => identity });
    store.setMe(identity);
    renderAccess(<BetaGate />, { store, me: identity });
    identity = mayaMe({ access: { ...admittedAccess, onboardingStep: "name" } });
    await user.click(await screen.findByRole("button", { name: "Check access" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/welcome"));
  });

  it("reports a failed access check", async () => {
    const user = userEvent.setup();
    const store = new SessionStore({
      me: async () => {
        throw new ApiNetworkError();
      },
    });
    store.setMe(mayaMe({ access: lockedAccess }));
    renderAccess(<BetaGate />, { store });
    await user.click(await screen.findByRole("button", { name: "Check access" }));
    expect(
      await screen.findByText("Symplist couldn't be reached. Check your connection and try again."),
    ).toBeInTheDocument();
  });

  it("offers sign-out and account management, and names the signed-in address", async () => {
    renderGate();
    expect(await screen.findByText(/Signed in as maya@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Account menu/ })).toBeInTheDocument();
  });

  it("sends an account that does not belong here to its own screen", async () => {
    renderAccess(<BetaGate />, { me: mayaMe() });
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/now"));
    expect(screen.queryByLabelText("Invite code")).not.toBeInTheDocument();
  });
});
