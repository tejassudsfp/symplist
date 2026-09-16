import { Body, Controller, Get, Inject, Param, Put } from "@nestjs/common";
import {
  type PreferenceEntry,
  type PreferenceGroup,
  type PreferencesPutRequest,
  type PreferencesPutResponse,
  type PreferencesResponse,
  preferenceGroupSchema,
  preferencesPutRequestSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { PreferencesService } from "@symplist/core/preferences";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { workspaceCall } from "./workspace.errors.ts";
import { WorkspaceEvents } from "./workspace.events.ts";
import { PREFERENCES_SERVICE } from "./workspace.providers.ts";

/**
 * Versioned, encrypted preference groups (§10.3): appearance, keyboard, chat, recent, panels and
 * privacy. A save applies only at its `baseVersion`; a stale save answers 409 `preferences.conflict`
 * with the current version and data, and every response echoes `clientSeq` so the client can drop
 * responses older than its latest save. Saves are naturally idempotent through the version, so they
 * take no `Idempotency-Key`.
 */
@Controller("preferences")
@RouteClass("app")
export class PreferencesController {
  constructor(
    @Inject(PREFERENCES_SERVICE) private readonly preferences: PreferencesService,
    @Inject(WorkspaceEvents) private readonly events: WorkspaceEvents,
  ) {}

  @Get()
  @Access("admitted")
  all(@CurrentSession() session: SessionContext): Promise<PreferencesResponse> {
    return workspaceCall(async () => ({
      groups: (await this.preferences.getAll(session.userId)) as PreferencesResponse["groups"],
    }));
  }

  @Get(":group")
  @Access("admitted")
  one(
    @CurrentSession() session: SessionContext,
    @Param("group", { schema: preferenceGroupSchema }) group: PreferenceGroup,
  ): Promise<PreferenceEntry> {
    return workspaceCall(
      async () => (await this.preferences.get(session.userId, group)) as PreferenceEntry,
    );
  }

  @Put(":group")
  @Access("admitted")
  async save(
    @CurrentSession() session: SessionContext,
    @Param("group", { schema: preferenceGroupSchema }) group: PreferenceGroup,
    @Body({ schema: preferencesPutRequestSchema }) body: PreferencesPutRequest,
  ): Promise<PreferencesPutResponse> {
    const result = await workspaceCall(() =>
      this.preferences.put({
        ownerId: session.userId,
        group,
        baseVersion: body.baseVersion,
        clientSeq: body.clientSeq,
        data: body.data,
      }),
    );
    const response: PreferencesPutResponse = {
      group,
      version: result.entry.version,
      data: result.entry.data,
      updatedAt: result.entry.updatedAt,
      clientSeq: result.clientSeq,
    };
    if (result.kind === "conflict") {
      throw new ApiError("preferences.conflict", { details: { ...response } });
    }
    if (result.changed) this.events.preferencesChanged(session.userId, group, result.entry.version);
    return response;
  }
}
