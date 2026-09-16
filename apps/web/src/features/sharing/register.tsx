"use client";
import { setArtifactSurface } from "@/features/documents/artifact-surface";
import { taskMenuExtensions } from "@/features/workspace/task-menu-extensions";
import { ArtifactsManager } from "./artifacts-manager.tsx";

setArtifactSurface((context) => <ArtifactsManager key={context.taskId} {...context} />);
for (const [id, label, destination] of [
  ["sharing.prepare_handoff", "Prepare handoff", "handoff"],
  ["sharing.manage_links", "Artifacts and links", "artifacts"],
] as const) {
  if (!taskMenuExtensions.some((entry) => entry.id === id))
    taskMenuExtensions.push({
      id,
      actionId: id,
      label,
      onSelect: (taskId) => {
        window.location.assign(`/tasks/${encodeURIComponent(taskId)}/${destination}`);
      },
    });
}
