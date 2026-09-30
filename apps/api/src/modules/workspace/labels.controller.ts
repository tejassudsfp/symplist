import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  idSchema,
  type LabelCreate,
  type LabelList,
  type LabelUpdate,
  type LabelView,
  labelCreateSchema,
  labelUpdateSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { LabelService } from "@symplist/core/tasks";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { workspaceCall } from "./workspace.errors.ts";
import { LABEL_SERVICE } from "./workspace.providers.ts";

/**
 * Labels (§2.1): the owner's own words for slices of their list, with the active task count each one
 * carries so the filter bar can show it.
 *
 * No route takes an `Idempotency-Key`, and each one is idempotent for a different reason rather than by
 * machinery. A create that is retried after a lost response answers 409 `label.duplicate_name` with
 * `details.labelId` — the id of the label the first attempt made, which is exactly what the retry
 * wanted. A patch sets an absolute name and colour. A delete of a label already gone is 404. The set a
 * task carries is replaced whole by `PUT /v1/tasks/:id/labels` on {@link TasksController}.
 */
@Controller("labels")
@RouteClass("app")
export class LabelsController {
  constructor(@Inject(LABEL_SERVICE) private readonly labels: LabelService) {}

  @Get()
  @Access("admitted")
  list(@CurrentSession() session: SessionContext): Promise<LabelList> {
    return workspaceCall(() => this.labels.list(session.userId));
  }

  @Post()
  @Access("admitted")
  create(
    @CurrentSession() session: SessionContext,
    @Body({ schema: labelCreateSchema }) body: LabelCreate,
  ): Promise<LabelView> {
    return workspaceCall(() => this.labels.create(session.userId, body));
  }

  @Patch(":id")
  @Access("admitted")
  update(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: idSchema }) labelId: string,
    @Body({ schema: labelUpdateSchema }) body: LabelUpdate,
  ): Promise<LabelView> {
    return workspaceCall(() => this.labels.update(session.userId, labelId, body));
  }

  @Delete(":id")
  @HttpCode(204)
  @Access("admitted")
  remove(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: idSchema }) labelId: string,
  ): Promise<void> {
    return workspaceCall(() => this.labels.remove(session.userId, labelId));
  }
}
