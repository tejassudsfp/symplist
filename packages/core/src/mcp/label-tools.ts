import {
  type LabelCreateToolOutput,
  type LabelListToolOutput,
  mcpLabelCreateSchema,
  mcpLabelListSchema,
  mcpTaskSetLabelsSchema,
  type TaskSetLabelsToolOutput,
} from "@symplist/contracts";
import type { z } from "zod";
import { TaskOperationError } from "../tasks/errors.ts";
import type { LabelService } from "../tasks/label-service.ts";
import type { McpGrants } from "./grants.ts";
import { McpError, type McpIdentity } from "./types.ts";

/**
 * Labels over MCP (§2.1, §14.6): list them, add one, and set the ones a task carries.
 *
 * There is no rename and no delete. Either one changes every task carrying the label, including tasks
 * outside the grant, and a person's own words for their own list are not an agent's to withdraw.
 *
 * What a grant may see is decided the same way `McpTaskTools` decides it: a grant restricted to
 * particular tasks sees only the labels already on those tasks, and their counts within that scope. A
 * grant over three tasks is not a reason to learn the whole of someone's vocabulary.
 */
export class McpLabelTools {
  constructor(
    readonly grants: McpGrants,
    readonly labels: LabelService,
  ) {}

  async list(
    identity: McpIdentity,
    input: z.input<typeof mcpLabelListSchema>,
  ): Promise<LabelListToolOutput> {
    mcpLabelListSchema.parse(input);
    await this.grants.require(identity, "tasks:read", []);
    return { labels: await this.visible(identity) };
  }

  /**
   * Adds a label, or answers with the one that already has the name.
   *
   * Resolving rather than refusing is what makes the tool safe to retry without a `requestId`: a call
   * whose response was lost asks again and is told the id its first attempt made.
   */
  async create(
    identity: McpIdentity,
    input: z.input<typeof mcpLabelCreateSchema>,
  ): Promise<LabelCreateToolOutput> {
    const args = mcpLabelCreateSchema.parse(input);
    // `null` is all-task scope: a label belongs to the whole list, not to the tasks a grant covers.
    await this.grants.require(identity, "tasks:write", null);
    try {
      const label = await this.labels.create(identity.ownerId, args);
      return { labelId: label.id, name: label.name, colour: label.colour, created: true };
    } catch (error) {
      if (!(error instanceof TaskOperationError) || error.code !== "label.duplicate_name")
        throw error;
      const existingId = error.details?.labelId;
      const existing = (await this.labels.list(identity.ownerId)).labels.find(
        (label) => label.id === existingId,
      );
      if (!existing) throw error;
      return { labelId: existing.id, name: existing.name, colour: existing.colour, created: false };
    }
  }

  async setTaskLabels(
    identity: McpIdentity,
    input: z.input<typeof mcpTaskSetLabelsSchema>,
  ): Promise<TaskSetLabelsToolOutput> {
    const args = mcpTaskSetLabelsSchema.parse(input);
    await this.grants.require(identity, "tasks:write", [args.taskId]);
    // Every label named has to be one this grant can already see, so a scoped agent cannot apply a
    // label it was never shown and learn by the refusal whether that id exists.
    const visible = new Set((await this.visible(identity)).map((label) => label.id));
    for (const id of args.labelIds) if (!visible.has(id)) throw new McpError("mcp.not_found");
    return await this.labels.setTaskLabels(identity.ownerId, args.taskId, args.labelIds);
  }

  /** The owner's labels as this grant may see them, with counts narrowed to its tasks. */
  private async visible(identity: McpIdentity): Promise<LabelListToolOutput["labels"]> {
    const { labels } = await this.labels.list(identity.ownerId, { taskIds: identity.taskIds });
    return labels;
  }
}
