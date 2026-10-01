import { Inject, Injectable } from "@nestjs/common";
import type { BugReportCreate, BugReportReceipt } from "@symplist/contracts";
import { BUG_REPORT_CONTEXT_MAX_LENGTH } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import { bugReportContext, bugReportKey, encryptFieldText, zeroize } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";

/** What the controller knows that the body does not: who is reporting, and what the api itself saw. */
export interface BugReportRequest extends BugReportCreate {
  /** The signed-in reporter, or null for a report filed with nobody signed in. */
  readonly reporterId: string | null;
  /** The `User-Agent` header, read from the request rather than taken from the body. */
  readonly userAgent: string | null;
}

/** Trims a context value to the column's bound; a header is not validated by the body schema. */
function context(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, BUG_REPORT_CONTEXT_MAX_LENGTH);
}

/**
 * Filing a bug report: one row in `bugs`, in one D1 round trip.
 *
 * The report text is a field envelope under the table's own key — see
 * `migrations/0019_bug_reports.sql` for why it is not under an account data key, and
 * `@symplist/crypto`'s `bugReportKey` for what it is under instead. Deriving the key needs no D1 read,
 * which is what keeps the write to a single batch: the insert and the write-id verification go in one
 * request, because a round trip on this lane is the thing that costs (CLAUDE.md, D1 budget).
 */
@Injectable()
export class BugReportsService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async file(input: BugReportRequest): Promise<BugReportReceipt> {
    const now = this.clock.now();
    const id = uuidv7(now);
    const writeId = uuidv7(now);
    const key = bugReportKey(this.keys, input.reporterId);
    let reportEnc: string;
    try {
      reportEnc = encryptFieldText(key, bugReportContext(input.reporterId, id), input.report);
    } finally {
      zeroize(key.key);
    }
    const results = await this.db.batch([
      sql(
        `INSERT INTO bugs (
           id, reporter_id, report_enc, kek_version, surface, page, app_version, platform,
           user_agent, created_at, write_id)
         VALUES (
           :id, :reporter, :report, CAST(:kek AS INTEGER), :surface, :page, :version, :platform,
           :agent, :now, :w)`,
        {
          id,
          reporter: input.reporterId,
          report: reportEnc,
          kek: int(key.kekVersion),
          surface: input.surface,
          page: context(input.page),
          version: context(input.appVersion),
          platform: context(input.platform),
          agent: context(input.userAgent),
          now: int(now),
          w: writeId,
        },
      ),
      sql("SELECT id FROM bugs WHERE id = :id AND write_id = :w", { id, w: writeId }),
    ]);
    // A report that was not stored must not answer with a receipt: the person would close the dialog
    // believing it had been sent, and nothing anywhere would hold what they wrote.
    if (!verifiedRow(results, 1)) throw ApiError.internal();
    return { id, createdAt: now };
  }
}
