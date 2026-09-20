import { describe, expect, it } from "vitest";
import { adminAccountFixture, adminEventFixture } from "../test-support.tsx";
import { accountState, eventResult, eventSentence, targetName } from "./labels.ts";

describe("administration labels (admin_activity.md, admin_accounts.md)", () => {
  it("reads redemptions and capacity changes as sentences", () => {
    expect(eventSentence(adminEventFixture())).toBe(
      "maya@example.com redeemed Friends — September",
    );
    expect(
      eventSentence(
        adminEventFixture({
          actor: { kind: "admin", id: null, email: "tejas@example.com" },
          action: "invite_capacity_changed",
          before: { maxRedemptions: 5 },
          after: { maxRedemptions: 8 },
        }),
      ),
    ).toBe("tejas@example.com increased capacity from 5 to 8 for Friends — September");
  });

  it("counts generated codes", () => {
    expect(
      eventSentence(adminEventFixture({ action: "invite_generated", after: { count: 3 } })),
    ).toBe("maya@example.com generated 3 codes for Friends — September");
  });

  it("names the system and deleted accounts", () => {
    expect(
      eventSentence(
        adminEventFixture({
          actor: { kind: "system", id: null, email: null },
          action: "admin_bootstrap",
          target: { kind: "user", id: null, label: null },
          campaign: null,
        }),
      ),
    ).toBe("Symplist became the first administrator · Deleted account");
    expect(
      targetName(adminEventFixture({ target: { kind: "system", id: null, label: null } })),
    ).toBeNull();
  });

  it("summarizes what a change resulted in", () => {
    expect(
      eventResult(
        adminEventFixture({ before: { betaState: "unlocked" }, after: { betaState: "relocked" } }),
      ),
    ).toBe("beta state unlocked → relocked");
    expect(eventResult(adminEventFixture())).toBe("—");
  });

  it("reads an account's state from its independent access fields (§5.4)", () => {
    expect(accountState(adminAccountFixture())).toBe("unlocked");
    expect(accountState(adminAccountFixture({ emailVerifiedAt: null }))).toBe("pending");
    expect(accountState(adminAccountFixture({ betaState: "locked" }))).toBe("locked");
    expect(accountState(adminAccountFixture({ betaState: "relocked" }))).toBe("paused");
    expect(accountState(adminAccountFixture({ suspendedAt: 1 }))).toBe("paused");
    expect(accountState(adminAccountFixture({ deletionState: "deleting" }))).toBe("deleting");
  });
});
