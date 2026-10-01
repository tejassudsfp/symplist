/**
 * Bug reports: what somebody typed when something went wrong.
 *
 * In `common/` rather than under a feature because it belongs to none of them. The report is reachable
 * from the signed-in workspace, from the public site with nobody signed in, and from the desktop shell
 * that loads the same web app — so no feature owns it, and the signed-out case means the request
 * cannot assume a session.
 *
 * The report text is the person's own words and is encrypted at rest like a task title; everything
 * beside it is context a client fills in so the report can be placed, and is stored in the clear.
 */

import { idSchema } from "./ids.ts";
import { epochMillisSchema } from "./primitives.ts";
import { z } from "./zod.ts";

/**
 * Where a report came from. Three values and not a free string, because this is the one piece of
 * context a triage list groups by, and because `workspace` and `desktop` are the same web app: only
 * the client can tell them apart, and only if it is asked for one of a known set.
 */
export const bugReportSurfaces = ["workspace", "site", "desktop"] as const;
export const bugReportSurfaceSchema = z.enum(bugReportSurfaces);
export type BugReportSurface = z.infer<typeof bugReportSurfaceSchema>;

/**
 * How long a report may be.
 *
 * Long enough for what happened and what they expected, short enough that the form is obviously a
 * message and not a document — the task's own page is where long writing belongs.
 */
export const BUG_REPORT_MAX_LENGTH = 2000;

/** How long each context value may be; anything longer is a client sending junk, not context. */
export const BUG_REPORT_CONTEXT_MAX_LENGTH = 200;

/**
 * The report as stored: outer whitespace trimmed, and non-empty.
 *
 * Trimmed and not otherwise normalised: unlike a label name, nothing compares two reports, and the
 * line breaks somebody used to separate "what I did" from "what happened" are part of what they wrote.
 */
export const bugReportTextSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { error: "Tell us what happened" })
  .refine((value) => value.length <= BUG_REPORT_MAX_LENGTH, {
    error: `At most ${BUG_REPORT_MAX_LENGTH} characters`,
  });

const contextValueSchema = z.string().max(BUG_REPORT_CONTEXT_MAX_LENGTH);

export const bugReportCreateSchema = z.strictObject({
  report: bugReportTextSchema,
  surface: bugReportSurfaceSchema,
  /** The route they were on, path only: a query string could carry what they typed somewhere else. */
  page: contextValueSchema.optional(),
  /** The build they were running, when the surface knows its own version. */
  appVersion: contextValueSchema.optional(),
  /** The platform the shell reports (`darwin`, `win32`); a browser leaves it to the user agent. */
  platform: contextValueSchema.optional(),
});
export type BugReportCreate = z.infer<typeof bugReportCreateSchema>;

/**
 * What a filed report answers with: its id and when it landed, and nothing that was sent.
 *
 * Deliberately not the report itself. Nothing reads a report back — there is no triage screen and no
 * list of your own reports — and an endpoint that echoes an unauthenticated write is an endpoint that
 * can be asked to decrypt one.
 */
export const bugReportReceiptSchema = z.strictObject({
  id: idSchema,
  createdAt: epochMillisSchema,
});
export type BugReportReceipt = z.infer<typeof bugReportReceiptSchema>;
