/**
 * Invite codes (note 04): 20 random bytes as 32 RFC 4648 Base32 characters, shown in groups of four
 * after a `SYM-` prefix. Normalization is shared by the web (grouped display of a pasted code) and the
 * api (digest input), so both sides agree on what a code is. Browser-safe: no Node imports.
 */

/** RFC 4648 Base32 alphabet (no padding). */
export const inviteCodeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 characters in a canonical invite code (160 random bits). */
export const inviteCodeLength = 32;

/** The display prefix of every invite code. */
export const inviteCodePrefix = "SYM";

/** Characters of the canonical code kept as the non-secret display hint. */
export const inviteHintLength = 4;

/** The longest raw input accepted for a code (a pasted code with generous spacing). */
export const inviteCodeInputMaxLength = 128;

const canonicalPattern = /^[A-Z2-7]{32}$/;
/** Whitespace and the separators people type or paste between groups. */
const separators = /[\s\-_.·‐-―−]/gu;

/**
 * The canonical form of a typed or pasted code, or null when it cannot be a code: Unicode NFKC (so
 * full-width characters count), upper case, whitespace and separators removed, and an optional `SYM`
 * prefix dropped. Normalizing a canonical code returns it unchanged.
 */
export function normalizeInviteCode(input: string): string | null {
  if (typeof input !== "string" || input.length > inviteCodeInputMaxLength) return null;
  let text = input.normalize("NFKC").toUpperCase().replace(separators, "");
  if (text.length === inviteCodeLength + inviteCodePrefix.length && text.startsWith("SYM")) {
    text = text.slice(inviteCodePrefix.length);
  }
  return canonicalPattern.test(text) ? text : null;
}

/** `SYM-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` for a canonical code. */
export function formatInviteCode(canonical: string): string {
  if (!canonicalPattern.test(canonical)) throw new Error("Expected a canonical invite code");
  const groups = canonical.match(/.{4}/g) ?? [];
  return [inviteCodePrefix, ...groups].join("-");
}

/** The non-secret hint of a canonical code: its last four characters. */
export function inviteCodeHint(canonical: string): string {
  if (!canonicalPattern.test(canonical)) throw new Error("Expected a canonical invite code");
  return canonical.slice(-inviteHintLength);
}

/** How a hint is shown next to an invite: `SYM-…-WXYZ`. Never a recoverable code. */
export function formatInviteHint(hint: string): string {
  return `${inviteCodePrefix}-…-${hint}`;
}
