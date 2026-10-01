import { describe, expect, it } from "vitest";
import { expectCryptoError } from "../test/support.ts";
import {
  ANONYMOUS_REPORTER,
  BUG_REPORT_PURPOSE,
  bugReportContext,
  bugReportKey,
} from "./bug-reports.ts";
import { decryptFieldText, encryptFieldText } from "./envelopes.ts";
import { DecryptionFailedError, KeyUnavailableError } from "./errors.ts";
import { createKeyProvider } from "./key-provider.ts";
import { generateToken } from "./tokens.ts";

const reporter = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const other = "0199a1b2-c3d4-7e5f-8a6b-000000000002";
const bugId = "0199a1b2-0000-7000-8000-000000000001";

function keys(current = 2) {
  return createKeyProvider({
    CONTENT_KEK: {
      current,
      versions: new Map([
        [1, generateToken()],
        [2, generateToken()],
      ]),
    },
  });
}

describe("bug report envelopes", () => {
  it("binds the row to its reporter, table, row and column", () => {
    expect(bugReportContext(reporter, bugId)).toEqual({
      purpose: BUG_REPORT_PURPOSE,
      ownerId: reporter,
      table: "bugs",
      rowId: bugId,
      column: "report_enc",
    });
    expect(bugReportContext(null, bugId).ownerId).toBe(ANONYMOUS_REPORTER);
  });

  it("round-trips a report under the table key and records the KEK version that derived it", () => {
    const provider = keys();
    const key = bugReportKey(provider, reporter);
    expect(key.kekVersion).toBe(2);
    const context = bugReportContext(reporter, bugId);
    const envelope = encryptFieldText(key, context, "The task page went blank");
    expect(envelope.startsWith("sym1.1.")).toBe(true);
    expect(decryptFieldText(bugReportKey(provider, reporter, 2), context, envelope)).toBe(
      "The task page went blank",
    );
  });

  it("needs the recorded KEK version, because nothing re-wraps a key derived from the KEK", () => {
    const provider = keys();
    const envelope = encryptFieldText(
      bugReportKey(provider, null),
      bugReportContext(null, bugId),
      "Sign in did nothing",
    );
    expectCryptoError(
      () =>
        decryptFieldText(bugReportKey(provider, null, 1), bugReportContext(null, bugId), envelope),
      DecryptionFailedError,
    );
    expectCryptoError(() => bugReportKey(provider, null, 3), KeyUnavailableError);
  });

  it("refuses to read one reporter's report as another's, or an anonymous one as anybody's", () => {
    const provider = keys();
    const mine = encryptFieldText(
      bugReportKey(provider, reporter),
      bugReportContext(reporter, bugId),
      "Reminders fire twice",
    );
    expectCryptoError(
      () => decryptFieldText(bugReportKey(provider, other), bugReportContext(other, bugId), mine),
      DecryptionFailedError,
    );
    const anonymous = encryptFieldText(
      bugReportKey(provider, null),
      bugReportContext(null, bugId),
      "Reminders fire twice",
    );
    expectCryptoError(
      () =>
        decryptFieldText(
          bugReportKey(provider, reporter),
          bugReportContext(reporter, bugId),
          anonymous,
        ),
      DecryptionFailedError,
    );
  });

  it("gives a different row a different envelope for the same words", () => {
    const provider = keys();
    const key = bugReportKey(provider, null);
    const first = encryptFieldText(key, bugReportContext(null, bugId), "Same words");
    const second = encryptFieldText(
      key,
      bugReportContext(null, "0199a1b2-0000-7000-8000-000000000002"),
      "Same words",
    );
    expect(first).not.toBe(second);
  });
});
