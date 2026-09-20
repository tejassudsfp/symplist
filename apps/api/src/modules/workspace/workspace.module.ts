import { Module } from "@nestjs/common";
import { PreferencesController } from "./preferences.controller.ts";
import { ArchiveController, TasksController } from "./tasks.controller.ts";
import { WorkspaceEvents } from "./workspace.events.ts";
import { workspaceProviders } from "./workspace.providers.ts";

/**
 * The workspace feature (§2.1, §10.3): the task tree, the archive and preferences over `core/tasks`
 * and `core/preferences`, with their caches, `tasks.changed` and `preferences.changed` events, the
 * user topic's `taskTreeVersion` and the worker's `tasks.changed` internal event.
 */
@Module({
  controllers: [TasksController, ArchiveController, PreferencesController],
  providers: [...workspaceProviders, WorkspaceEvents],
})
export class WorkspaceModule {}
