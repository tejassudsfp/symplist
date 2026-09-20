import type { OtpChallengeResponse } from "@symplist/contracts";
import { describe, expect, it, vi } from "vitest";
import { AccessFeatureError } from "../access/feature-error.ts";
import type { OtpService } from "../access/otp.ts";
import type { AccountDeletionService } from "./deletion.ts";
import { AccountDeletionRequestService } from "./deletion-request.ts";

const requester = {
  userId: "0192f0a0-0000-7000-8000-000000000001",
  sessionId: "0192f0a0-0000-7000-8000-000000000002",
};
const now = 1_789_500_000_000;

function service(result: Awaited<ReturnType<AccountDeletionService["delete"]>>) {
  const challenge: OtpChallengeResponse = {
    challengeId: "0192f0a0-0000-7000-8000-000000000003",
    purpose: "account_delete",
    expiresAt: now + 600_000,
    resendAvailableAt: now + 60_000,
    codeLength: 6,
  };
  const otp = {
    sendForSession: vi.fn(async () => challenge),
    verify: vi.fn(),
  };
  const deletion = { delete: vi.fn(async () => result) };
  return {
    otp,
    deletion,
    requests: new AccountDeletionRequestService({
      otp: otp as unknown as Pick<OtpService, "sendForSession" | "verify">,
      deletion,
      now: () => now,
    }),
  };
}

describe("account deletion requests (§5.6)", () => {
  it("sends an account_delete code bound to the requesting session", async () => {
    const { otp, requests } = service({ status: "deleted", analyticsId: null });
    await requests.sendCode(requester);
    expect(otp.sendForSession).toHaveBeenCalledWith({ ...requester, purpose: "account_delete" });
  });

  it("verifies only account_delete challenges of this session", async () => {
    const { otp, requests } = service({ status: "deleted", analyticsId: null });
    otp.verify.mockResolvedValue({ value: { authorizationId: "a", expiresAt: now + 600_000 } });
    await requests.verifyCode(requester, { challengeId: "c", code: "123456" });
    expect(otp.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: "c",
        code: "123456",
        purposes: ["account_delete"],
        binding: requester,
      }),
    );
  });

  it("runs the platform deletion batch and maps refusals", async () => {
    const deleted = service({ status: "deleted", analyticsId: "analytics" });
    expect(await deleted.requests.requestDeletion(requester, "auth")).toEqual({
      status: "deleted",
      analyticsId: "analytics",
    });
    expect(deleted.deletion.delete).toHaveBeenCalledWith({
      userId: requester.userId,
      authorizationId: "auth",
      authSessionId: requester.sessionId,
      now,
    });
    await expect(
      service({ status: "refused" }).requests.requestDeletion(requester, "auth"),
    ).rejects.toEqual(new AccessFeatureError("account.deletion_unauthorized"));
    await expect(
      service({ status: "not_found" }).requests.requestDeletion(requester, "auth"),
    ).rejects.toEqual(new AccessFeatureError("auth.session_required"));
  });
});
