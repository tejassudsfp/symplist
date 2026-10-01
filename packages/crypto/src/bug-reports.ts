import type { FieldEnvelopeContext } from "./envelopes.ts";
import { KeyUnavailableError } from "./errors.ts";
import { deriveKey, HKDF_LABELS } from "./hkdf.ts";
import type { AccountDataKey, KeyProvider } from "./keys.ts";

/**
 * The key and the binding of `bugs.report_enc`.
 *
 * Every other `_enc` column is content of one account and is encrypted under that account's data key,
 * so deleting the wrapped key crypto-shreds it. A bug report cannot be: anybody may report one,
 * including somebody who is not signed in and whose bug may be the reason they are not. There is no
 * account data key to reach for, so the table has one key of its own, derived from the current
 * `CONTENT_KEK` with a label of its own — see `migrations/0019_bug_reports.sql` for the trade and what
 * pays for it (the account purge deletes the rows outright).
 */

/** Field envelope purpose of `bugs.report_enc`. */
export const BUG_REPORT_PURPOSE = "bug_report";

/** The reporter an unauthenticated report is bound to, where a user id would otherwise go. */
export const ANONYMOUS_REPORTER = "anonymous";

/**
 * The envelope binding of a report: the reporter (their user id, or `anonymous`), table `bugs`, the
 * row's id and column `report_enc`. The AAD is what keeps a signed-out row from being replayed as a
 * particular person's, and one person's row from being read as another's.
 */
export function bugReportContext(reporterId: string | null, bugId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: BUG_REPORT_PURPOSE,
    ownerId: reporterId ?? ANONYMOUS_REPORTER,
    table: "bugs",
    rowId: bugId,
    column: "report_enc",
  });
}

/**
 * `HKDF(CONTENT_KEK_<version>, "symplist/bug-report/v1")`, shaped as the key the field envelope
 * functions take. `version` is the `kek_version` recorded on the row; omit it to derive from the
 * current version when writing a new one. The caller owns the returned buffer and should zeroise it.
 *
 * It is an {@link AccountDataKey} by type and not by nature: `ownerId` carries the reporter so that
 * `encryptField` enforces the same owner the AAD binds, and `kekVersion` is the version that *derived*
 * the key rather than one that wraps it.
 */
export function bugReportKey(
  keys: KeyProvider,
  reporterId: string | null,
  version?: number,
): AccountDataKey {
  const kek =
    version === undefined ? keys.current("CONTENT_KEK") : keys.get("CONTENT_KEK", version);
  if (!kek) throw new KeyUnavailableError("CONTENT_KEK", version);
  return Object.freeze({
    ownerId: reporterId ?? ANONYMOUS_REPORTER,
    kekVersion: kek.version,
    key: deriveKey(kek.key, HKDF_LABELS.bugReport),
  });
}
