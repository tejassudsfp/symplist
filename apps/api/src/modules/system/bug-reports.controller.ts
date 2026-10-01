import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import {
  type BugReportCreate,
  type BugReportReceipt,
  bugReportCreateSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { IpLimit } from "../../infra/limits/ip-limits.ts";
import { BugReportsService } from "./bug-reports.service.ts";

function userAgent(req: Request): string | null {
  const value = req.headers["user-agent"];
  return typeof value === "string" ? value : null;
}

/**
 * Filing a bug report, from anywhere.
 *
 * **Two routes and one service, because of the route classes and not in spite of them** (§5.3). A
 * report has to work with nobody signed in — the bug may be the reason they are not — and the `app`
 * class requires a session, so the signed-out route cannot use it. The class that does take an
 * unauthenticated write from the web app is `pre_session`, and it strips every cookie before the
 * handler, so a `pre_session` route can never say who filed the report. Attribution and anonymity are
 * therefore two routes:
 *
 * - `POST /v1/bugs` — `app` class, identity level. The workspace, and the desktop shell that loads it.
 * - `POST /v1/bugs/anonymous` — `pre_session` class. The public site, with nobody signed in.
 *
 * Collapsing them would take a class that reads the session cookie but does not require one, which is
 * a new row in the §5.3 table and not a thing to invent for one form. Both routes share one per-IP
 * bucket, so signing in buys no extra allowance, and both end in `BugReportsService.file`.
 */
@Controller("bugs")
export class BugReportsController {
  constructor(private readonly bugs: BugReportsService) {}

  /** A report from a signed-in person, attributed to them. */
  @Post()
  @RouteClass("app")
  @Access("identity")
  @IpLimit("bug_report")
  @HttpCode(201)
  file(
    @CurrentSession() session: SessionContext,
    @Body({ schema: bugReportCreateSchema }) body: BugReportCreate,
    @Req() req: Request,
  ): Promise<BugReportReceipt> {
    return this.bugs.file({ ...body, reporterId: session.userId, userAgent: userAgent(req) });
  }

  /**
   * A report from a visitor with no session. `reporter_id` stays null, and the row is encrypted bound
   * to `anonymous` rather than to a person — there is no account data key to use and no account to
   * shred it with.
   */
  @Post("anonymous")
  @RouteClass("pre_session")
  @IpLimit("bug_report")
  @HttpCode(201)
  fileAnonymously(
    @Body({ schema: bugReportCreateSchema }) body: BugReportCreate,
    @Req() req: Request,
  ): Promise<BugReportReceipt> {
    return this.bugs.file({ ...body, reporterId: null, userAgent: userAgent(req) });
  }
}
