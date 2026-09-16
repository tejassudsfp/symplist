import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { ServerAnalyticsEmitter } from "@symplist/analytics/server";
import {
  type PreferenceGroup,
  TASKS_CHANGED_MAX_IDS,
  taskIdSchema,
  type WsEvent,
} from "@symplist/contracts";
import type { InternalEvent, InternalEventPayload, RealtimePublisher } from "@symplist/core/events";
import {
  onTaskTreeCommitted,
  TASK_TREE_CHANGED_EVENT,
  type TaskAnalyticsSubject,
  type TaskTreeCache,
  type TaskTreeCommit,
  type TaskWriteResult,
  taskTreeVersionFromRow,
  taskTreeVersionStatement,
} from "@symplist/core/tasks";
import { type DbClient, sql } from "@symplist/db";
import { AppLogger } from "../../common/logging/logger.ts";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { REALTIME_PUBLISHER } from "../realtime/realtime.tokens.ts";
import { TopicRegistry } from "../realtime/topic-registry.ts";
import { TASK_TREE_CACHE } from "./workspace.providers.ts";

/** The internal event type the worker announces after it changed an owner's tasks (§3.3, §6.2). */
export const TASKS_CHANGED_INTERNAL_EVENT = TASK_TREE_CHANGED_EVENT;

/** Task ids one ownership statement binds, inside D1's 100 parameters per statement (§3.2). */
const OWNED_ID_CHUNK = 80;

function chunk<Item>(items: readonly Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * The workspace's realtime and analytics side (§3.3, §7, §15):
 *
 * - every committed task tree write made through the api's D1 client (the workspace routes, and Simon
 *   or MCP tools calling `core/tasks` in this process) keeps the tree cache exact or evicts it and
 *   publishes `tasks.changed` to the owner;
 * - worker writes arrive as the `task_tree.changed` internal event, whose payload is only a hint: the
 *   version and the owner's task ids are read again from D1 before anything is published;
 * - the `user` topic snapshot carries the owner's `taskTreeVersion`, read fresh from D1.
 */
@Injectable()
export class WorkspaceEvents implements OnModuleInit, OnApplicationShutdown {
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(TASK_TREE_CACHE) private readonly cache: TaskTreeCache,
    @Inject(REALTIME_PUBLISHER) private readonly publisher: RealtimePublisher,
    @Inject(TopicRegistry) private readonly topics: TopicRegistry,
    @Inject(InternalEventHandlerRegistry) private readonly internal: InternalEventHandlerRegistry,
    @Inject(SERVER_ANALYTICS) private readonly analytics: ServerAnalyticsEmitter,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = onTaskTreeCommitted(this.db, (commit) => this.committed(commit));
    this.topics.registerUserSnapshotContributor({
      name: "task_tree",
      contribute: async (socket) => {
        const row = await this.db.first(taskTreeVersionStatement(socket.userId));
        return { taskTreeVersion: taskTreeVersionFromRow(row) ?? 0 };
      },
    });
    this.internal.register({
      type: TASKS_CHANGED_INTERNAL_EVENT,
      handle: (event) => this.workerChanged(event),
    });
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Publishes `preferences.changed` to the owner's sockets. */
  preferencesChanged(ownerId: string, group: PreferenceGroup, version: number): void {
    this.publish(ownerId, { type: "preferences.changed", data: { group, version } });
  }

  /** Captures the server-owned analytics event of an applied write (§15); never blocks or throws. */
  captured(result: TaskWriteResult<unknown>): void {
    if (result.kind !== "applied" || result.analytics === null) return;
    const { event, subject, eventId } = result.analytics;
    void this.capture(event, subject, eventId);
  }

  private async capture(
    event: NonNullable<
      Extract<TaskWriteResult<unknown>, { kind: "applied" }>["analytics"]
    >["event"],
    subject: TaskAnalyticsSubject,
    eventId: string,
  ): Promise<void> {
    try {
      await this.analytics.capture({
        subject,
        event: event.event,
        properties: event.properties,
        eventId,
      } as Parameters<ServerAnalyticsEmitter["capture"]>[0]);
    } catch {
      this.logger.warn("workspace.analytics_failed");
    }
  }

  private committed(commit: TaskTreeCommit): void {
    const cached = this.cache.get(commit.ownerId);
    // The service already stored the exact state of its own commit; anything older is out of date.
    if (cached && cached.version < commit.taskTreeVersion) this.cache.delete(commit.ownerId);
    this.publishTasksChanged(commit.ownerId, commit.taskTreeVersion, commit.taskIds);
  }

  private async workerChanged(event: InternalEvent<string, InternalEventPayload>): Promise<void> {
    const hinted = (
      Array.isArray(event.payload.taskIds)
        ? event.payload.taskIds.filter((id) => taskIdSchema.safeParse(id).success)
        : []
    ).slice(0, TASKS_CHANGED_MAX_IDS);
    // One statement can bind at most 100 parameters (§3.2), and the hint may name up to
    // `TASKS_CHANGED_MAX_IDS`, so the ownership read is split across statements of one batch rather
    // than sent as a single `IN` list the D1 client would refuse.
    const idChunks = chunk(hinted, OWNED_ID_CHUNK);
    const results = await this.db.batch([
      taskTreeVersionStatement(event.ownerId),
      ...idChunks.map((ids) =>
        sql(`SELECT id FROM tasks WHERE owner_id = :owner AND id IN (:ids)`, {
          owner: event.ownerId,
          ids,
        }),
      ),
    ]);
    const version = taskTreeVersionFromRow(results[0]?.results[0]);
    if (version === null) return;
    const cached = this.cache.get(event.ownerId);
    if (cached && cached.version < version) this.cache.delete(event.ownerId);
    const owned = idChunks
      .flatMap((_ids, index) => results[index + 1]?.results ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string");
    this.publishTasksChanged(event.ownerId, version, owned);
  }

  private publishTasksChanged(ownerId: string, version: number, taskIds: readonly string[]): void {
    const unique = [...new Set(taskIds)];
    this.publish(ownerId, {
      type: "tasks.changed",
      data: {
        taskTreeVersion: version,
        taskIds: unique.length > TASKS_CHANGED_MAX_IDS ? [] : unique,
      },
    });
  }

  private publish(ownerId: string, event: { type: string; data: unknown }): void {
    this.publisher.publishToUser(ownerId, event as WsEvent).catch(() => {
      this.logger.warn("workspace.publish_failed", { event: event.type });
    });
  }
}
