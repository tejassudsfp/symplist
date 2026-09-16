import { documentHeadChangedEventSchema, taskIdSchema } from "@symplist/contracts";
import {
  DOCUMENT_HEAD_CHANGED_EVENT,
  type DocumentEventSink,
  type DocumentHeadChanged,
} from "@symplist/core/documents";
import type {
  InternalEvent,
  InternalEventHandler,
  UserSnapshotContributor,
} from "@symplist/core/events";
import type { DbClient } from "@symplist/db";
import { sql } from "@symplist/db";
import { z } from "zod";
import type { AppLogger } from "../../common/logging/logger.ts";
import type { TopicHub } from "../realtime/topic-hub.ts";

/**
 * Announces committed publications made by the api (user saves, restores, MCP and in-process Simon
 * edits) as `document.head_changed` on the owner's `user` topic (§7). Only ids go on the socket.
 */
export class RealtimeDocumentEvents implements DocumentEventSink {
  constructor(
    private readonly hub: TopicHub,
    private readonly logger: AppLogger,
  ) {}

  async headChanged(event: DocumentHeadChanged): Promise<void> {
    await this.hub.publishToUser(event.ownerId, {
      type: "document.head_changed",
      data: documentHeadChangedEventSchema.parse({
        taskId: event.taskId,
        revision: event.revision,
        author: event.author,
        changedSectionIds: event.changedSectionIds.slice(0, 100),
      }),
    });
  }

  onError(error: unknown): void {
    this.logger.warn("documents.announce_failed", { error });
  }
}

const payloadSchema = z.object({
  taskId: taskIdSchema,
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  generation: z.number().int().min(1),
  author: z.enum(["user", "simon", "mcp"]),
  changedSectionIds: z.array(z.string().regex(/^s[A-Za-z0-9_-]{25}$/)).max(100),
});

/**
 * Handles `document.head_changed` from the `document-git` task (§6.2). The payload is an untrusted
 * hint: the head is re-read from D1 for the event's owner, and the event carries the head D1 holds.
 * Changed section ids are relayed only when the hint names exactly that head.
 */
export function documentHeadChangedHandler(options: {
  readonly db: DbClient;
  readonly hub: TopicHub;
}): InternalEventHandler {
  return {
    type: DOCUMENT_HEAD_CHANGED_EVENT,
    async handle(event: InternalEvent) {
      const parsed = payloadSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const hint = parsed.data;
      const row = await options.db.first(
        sql(
          `SELECT head_commit_id, generation, head_author FROM doc_repos
           WHERE task_id = :task AND owner_id = :owner`,
          { task: hint.taskId, owner: event.ownerId },
        ),
      );
      if (!row || typeof row.generation !== "number" || row.generation < hint.generation) return;
      const exact = row.head_commit_id === hint.revision && row.generation === hint.generation;
      await options.hub.publishToUser(event.ownerId, {
        type: "document.head_changed",
        data: documentHeadChangedEventSchema.parse({
          taskId: hint.taskId,
          revision: row.head_commit_id,
          author: row.head_author,
          changedSectionIds: exact ? hint.changedSectionIds : [],
        }),
      });
    },
  };
}

/** Contributes `heads` to the `user` topic snapshot: the published revision of each open task (§7). */
export function documentHeadsContributor(db: DbClient): UserSnapshotContributor {
  return {
    name: "document_heads",
    async contribute(socket, input) {
      if (input.openTasks.length === 0) return {};
      const rows = await db.all(
        sql(
          `SELECT task_id, head_commit_id FROM doc_repos WHERE owner_id = :owner AND task_id IN (:tasks)`,
          { owner: socket.userId, tasks: [...input.openTasks] },
        ),
      );
      return {
        heads: Object.fromEntries(
          rows.map((row) => [row.task_id as string, row.head_commit_id as string]),
        ) as never,
      };
    },
  };
}
