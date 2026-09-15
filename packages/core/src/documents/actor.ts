import type { DocumentAuthorKind, Reader, SqlGuard } from "@symplist/docs";
import { DocumentError } from "@symplist/docs";

/**
 * Who calls a document service function, always from trusted identity (§8.7): the owner through the
 * app API, Simon in a run step, or an MCP grant. Caller-supplied owner ids are never trusted; the
 * runtime builds the actor from the authenticated session, run or grant.
 */
export type DocumentActor = UserDocumentActor | SimonDocumentActor | McpDocumentActor;

export interface UserDocumentActor {
  readonly kind: "user";
  readonly userId: string;
}

export interface SimonDocumentActor {
  readonly kind: "simon";
  readonly userId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly toolCallId: string;
  /** Increments when the conversation's context no longer holds earlier tool results (§9.4). */
  readonly contextEpoch: number;
  /** A task chat may edit its own task's document; quick chat reads referenced tasks only (§8.7). */
  readonly mode: "task" | "quick";
  /** The conversation's task in a task chat. */
  readonly taskId: string | null;
  /** Guards the run step folds into writes (run status, executor generation). */
  readonly guards?: readonly SqlGuard[];
}

export interface McpDocumentActor {
  readonly kind: "mcp";
  readonly userId: string;
  readonly grantId: string;
  /** The grant's scopes (§14.6): `tasks:read` for reads, `tasks:write` for edits and restore. */
  readonly scopes: readonly string[];
  /** The grant's task scope, or null for every task. */
  readonly taskIds: readonly string[] | null;
  /** A request id unique per MCP call, for publication idempotency. */
  readonly requestId: string;
  /** Guards the MCP layer folds into writes (grant still active at its generation). */
  readonly guards?: readonly SqlGuard[];
}

export function authorOf(actor: DocumentActor): DocumentAuthorKind {
  return actor.kind;
}

/** The receipt reader of an agent actor (§9.4); owners have no receipts. */
export function readerOf(actor: DocumentActor): Reader | null {
  switch (actor.kind) {
    case "simon":
      return { kind: "conversation", id: actor.conversationId };
    case "mcp":
      return { kind: "mcp_grant", id: actor.grantId };
    case "user":
      return null;
  }
}

/** The context epoch receipts are recorded under: Simon's conversation epoch, 0 for MCP grants. */
export function contextEpochOf(actor: DocumentActor): number {
  return actor.kind === "simon" ? actor.contextEpoch : 0;
}

/**
 * Checks what the actor may do with a task before any D1 access (§14.6, §8.7). A task outside an MCP
 * grant's task scope is `not_found`, the same shape as a foreign task.
 */
export function authorizeActor(
  actor: DocumentActor,
  taskId: string,
  operation: "read" | "write",
): void {
  if (actor.kind === "mcp") {
    if (actor.taskIds !== null && !actor.taskIds.includes(taskId))
      throw new DocumentError("not_found");
    const needed = operation === "write" ? ["tasks:write"] : ["tasks:read", "tasks:write"];
    if (!actor.scopes.some((scope) => needed.includes(scope))) {
      throw new DocumentError(operation === "write" ? "document.read_only" : "not_found");
    }
    return;
  }
  if (actor.kind === "simon" && operation === "write") {
    if (actor.mode !== "task" || actor.taskId !== taskId)
      throw new DocumentError("document.read_only");
  }
}

/** The publication request scope and id of an agent write (§9.2 step 1). */
export function agentRequest(actor: SimonDocumentActor | McpDocumentActor): {
  readonly scope: string;
  readonly id: string;
} {
  return actor.kind === "simon"
    ? { scope: `simon:${actor.runId}`, id: actor.toolCallId }
    : { scope: `mcp:${actor.grantId}`, id: actor.requestId };
}

/** Guards an agent folds into its writes. */
export function actorGuards(actor: DocumentActor): readonly SqlGuard[] {
  return actor.kind === "user" ? [] : (actor.guards ?? []);
}
