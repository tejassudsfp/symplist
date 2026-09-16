import { describe, expect, it } from "vitest";
import {
  vaultArgumentPathSchema,
  vaultGrantRequestSchema,
  vaultItemsResponseSchema,
  vaultResetRequestSchema,
  vaultSetupRequestSchema,
  vaultStatusSchema,
} from "./dto.ts";

const id = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001";
describe("Vault trust-boundary contracts", () => {
  it.each(["/token", "/headers/X-Key", "/array/0/key", "/escaped~1name/~0key"])(
    "accepts unambiguous JSON pointer %s",
    (path) => expect(vaultArgumentPathSchema.parse(path)).toBe(path),
  );
  it.each(["", "token", "/__proto__/value", "/constructor", "/prototype", "/bad~2escape"])(
    "rejects unsafe argument path %s",
    (path) => expect(vaultArgumentPathSchema.safeParse(path).success).toBe(false),
  );
  it("refuses mismatched setup/reset confirmation", () => {
    const input = { passphrase: "fictional long phrase", confirmation: "different long phrase" };
    expect(vaultSetupRequestSchema.safeParse(input).success).toBe(false);
    expect(vaultResetRequestSchema.safeParse({ ...input, authorizationId: id }).success).toBe(
      false,
    );
  });
  it("refuses authority supplied alongside a grant request", () => {
    const input = {
      itemId: id,
      itemVersion: 1,
      taskId: id,
      conversationId: id,
      toolSlug: "API_SEND",
      argumentPath: "/token",
      expiresAt: 123,
    };
    expect(vaultGrantRequestSchema.safeParse(input).success).toBe(true);
    expect(vaultGrantRequestSchema.safeParse({ ...input, ownerId: id }).success).toBe(false);
  });
  it("locked status cannot carry an item count and list summaries cannot carry values", () => {
    expect(
      vaultStatusSchema.safeParse({
        state: "locked",
        minimumKeyLength: 12,
        idleExpiresAt: null,
        count: 4,
      }).success,
    ).toBe(false);
    expect(
      vaultItemsResponseSchema.safeParse({
        items: [
          { id, type: "secret", title: "Example", version: 1, updatedAt: 1, value: "private" },
        ],
        nextCursor: null,
        idleExpiresAt: 100,
      }).success,
    ).toBe(false);
  });
});
