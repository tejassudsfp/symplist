import { describe, expect, it } from "vitest";
import {
  formatInviteCode,
  formatInviteHint,
  inviteCodeHint,
  normalizeInviteCode,
} from "./invite-code.ts";

const canonical = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Full-width forms of ASCII letters, digits and the hyphen. */
function fullWidth(text: string): string {
  return [...text]
    .map((character) =>
      character === "-" ? "－" : String.fromCodePoint((character.codePointAt(0) ?? 0) + 0xfee0),
    )
    .join("");
}

describe("invite code normalization (note 04)", () => {
  it("accepts the displayed form and every casing, spacing and separator variant", () => {
    const displayed = formatInviteCode(canonical);
    expect(displayed).toBe("SYM-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567");
    for (const variant of [
      canonical,
      displayed,
      displayed.toLowerCase(),
      ` ${displayed.replaceAll("-", " ")} `,
      displayed.replace(/^SYM-/, ""),
      `sym${canonical}`,
      displayed.replaceAll("-", "_"),
      displayed.replaceAll("-", "–"),
      fullWidth(displayed),
      `${displayed}\n`,
    ]) {
      expect(normalizeInviteCode(variant), variant).toBe(canonical);
    }
    expect(normalizeInviteCode(normalizeInviteCode(displayed) ?? "")).toBe(canonical);
  });

  it("rejects anything that cannot be a 160-bit Base32 code", () => {
    for (const invalid of [
      "",
      "SYM",
      canonical.slice(1),
      `${canonical}A`,
      canonical.replace("A", "0"),
      canonical.replace("B", "1"),
      canonical.replace("C", "8"),
      `XYZ${canonical}`,
      "x".repeat(129),
    ]) {
      expect(normalizeInviteCode(invalid), invalid).toBeNull();
    }
  });

  it("derives a four-character non-secret hint", () => {
    expect(inviteCodeHint(canonical)).toBe("4567");
    expect(formatInviteHint("4567")).toBe("SYM-…-4567");
    expect(() => inviteCodeHint("short")).toThrow();
    expect(() => formatInviteCode("SYM-ABCD")).toThrow();
  });
});
