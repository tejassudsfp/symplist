import { describe, expect, it, vi } from "vitest";
import type { AccessTransport } from "./api.ts";
import { createAccessApi } from "./api.ts";
import { adminInviteFixture, mayaMe } from "./test-support.tsx";

function recordingTransport() {
  const calls: Array<{ method: string; path: string; options: Record<string, unknown> }> = [];
  const transport = {
    get: vi.fn(async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ method: "GET", path, options });
      return undefined as never;
    }),
    post: vi.fn(async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ method: "POST", path, options });
      return undefined as never;
    }),
    put: vi.fn(async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ method: "PUT", path, options });
      return undefined as never;
    }),
  } as unknown as AccessTransport;
  return { transport, calls };
}

describe("the access routes over the browser client (decision AC1)", () => {
  it("sends the pre-session calls with their own CSRF class (§5.3)", async () => {
    const { transport, calls } = recordingTransport();
    const api = createAccessApi(transport);
    await api.lookup("maya@example.com");
    await api.signup("maya@example.com");
    await api.sendLoginCode("maya@example.com");
    await api.verifyCode("01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001", "123456");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/auth/lookup",
      "POST /v1/auth/signup",
      "POST /v1/auth/otp",
      "POST /v1/auth/otp/verify",
    ]);
    for (const call of calls) expect(call.options.csrf).toBe("pre_session");
    expect(calls[1]?.options.body).toEqual({ email: "maya@example.com", consent: true });
  });

  it("sends the app-class calls without a pre-session marker", async () => {
    const { transport, calls } = recordingTransport();
    const api = createAccessApi(transport);
    await api.me();
    await api.logout();
    await api.updateDisplayName("Maya");
    await api.completeOnboarding();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/me",
      "POST /v1/auth/logout",
      "PUT /v1/me/name",
      "POST /v1/me/onboarding/complete",
    ]);
    for (const call of calls) expect(call.options.csrf).toBeUndefined();
  });

  it("carries an idempotency key on every mutation that has side effects (§6.1)", async () => {
    const { transport, calls } = recordingTransport();
    const api = createAccessApi(transport);
    await api.redeem("SYM-CODE", "key-1");
    await api.requestDeletion("01929f3e-7c1a-7b2e-9a55-3c2f1d0e0002", "key-2");
    await api.generateInvites(
      { mode: "independent", count: 1, maxRedemptions: 1, expiresAt: Date.now() + 86_400_000 },
      "key-3",
    );
    await api.accountAction(
      mayaMe().user.id,
      "relock",
      { reason: "Abuse", expectedGeneration: 2 },
      "key-4",
    );
    expect(calls.map((call) => call.options.idempotencyKey)).toEqual([
      "key-1",
      "key-2",
      "key-3",
      "key-4",
    ]);
    expect(calls[3]?.path).toBe(`/v1/admin/accounts/${mayaMe().user.id}/relock`);
  });

  it("encodes ids in paths and filters query parameters", async () => {
    const { transport, calls } = recordingTransport();
    const api = createAccessApi(transport);
    await api.inviteDetail(adminInviteFixture().id);
    await api.listInvites({ status: "active", q: "friends" });
    await api.listActivity({ action: "invite_redeemed", from: 1_700_000_000_000 });
    expect(calls[0]?.path).toBe(`/v1/admin/invites/${adminInviteFixture().id}`);
    expect(calls[1]?.options.query).toEqual({ status: "active", q: "friends" });
    expect(calls[2]?.options.query).toEqual({
      action: "invite_redeemed",
      from: 1_700_000_000_000,
    });
  });

  it("passes an abort signal through to reads", async () => {
    const { transport, calls } = recordingTransport();
    const api = createAccessApi(transport);
    const controller = new AbortController();
    await api.me(controller.signal);
    await api.listAccounts({}, controller.signal);
    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect(calls[1]?.options.signal).toBe(controller.signal);
  });
});
