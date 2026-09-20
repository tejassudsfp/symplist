import {
  documentsErrorCodes,
  handoffRequestSchema,
  idSchema,
  sharingErrorCodes,
  sharingListQuerySchema,
  sharingProposalRequestSchema,
  sharingSnapshotRequestSchema,
} from "@symplist/contracts";
import { type SimonSharingOptions, SimonSharingSession } from "@symplist/core/simon";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { SimonToolContext } from "./turn.ts";

export function simonSharingTools(
  context: SimonToolContext,
  options: SimonSharingOptions,
): ToolSet {
  if (!context.documents) throw new Error("simon.document_context_required");
  const session = new SimonSharingSession(context.documents, options);
  const result = async (work: () => Promise<unknown>) => {
    if (context.signal.aborted) return { status: "failed", code: "simon.stale" };
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (
        typeof code === "string" &&
        (Object.hasOwn(sharingErrorCodes, code) ||
          Object.hasOwn(documentsErrorCodes, code) ||
          ["not_found", "idempotency.mismatch", "idempotency.in_progress"].includes(code))
      )
        return { status: "failed", code };
      throw error;
    }
  };
  return {
    artifact_share_list: tool({
      description:
        "List bounded private artifact and grant references for an explicitly referenced owned task. No share URLs or secret values are returned.",
      inputSchema: sharingListQuerySchema.extend({ taskId: idSchema }),
      execute: ({ taskId, ...query }, { toolCallId }) =>
        result(() => session.list(taskId, query, toolCallId)),
    }),
    ...(context.claim.run.taskId === null
      ? {}
      : {
          artifact_snapshot: tool({
            description:
              "Capture this task's explicit saved revision and selected sections as a private immutable artifact. This creates no recipient access or link.",
            inputSchema: sharingSnapshotRequestSchema.extend({ taskId: idSchema }),
            execute: ({ taskId, ...input }, { toolCallId }) =>
              result(() => session.snapshot(taskId, input, toolCallId)),
          }),
          artifact_share_create: tool({
            description:
              "Propose sharing an existing artifact at the expected source head. Returns only a proposal reference. The owner must review and release through trusted UI; never claim a link was created. Passwords belong only in trusted UI.",
            inputSchema: sharingProposalRequestSchema,
            execute: (input, { toolCallId }) => result(() => session.propose(input, toolCallId)),
          }),
          artifact_share_revoke: tool({
            description:
              "Revoke an explicit grant on this task's artifact. Already fetched copies cannot be recalled.",
            inputSchema: z.object({ artifactId: idSchema, grantId: idSchema }).strict(),
            execute: ({ artifactId, grantId }, { toolCallId }) =>
              result(() => session.revoke(artifactId, grantId, toolCallId)),
          }),
          handoff_prepare: tool({
            description:
              "Save an editable private handoff draft for this task from an explicit saved revision and artifact references. Write objective, constraints, read context, expected output, acceptance checks and open questions in prompt. No automatic send, external-agent launch or share link is created; references remain placeholders for owner review.",
            inputSchema: handoffRequestSchema.extend({ taskId: idSchema }),
            execute: ({ taskId, ...input }, { toolCallId }) =>
              result(() => session.handoff(taskId, input, toolCallId)),
          }),
        }),
  };
}
