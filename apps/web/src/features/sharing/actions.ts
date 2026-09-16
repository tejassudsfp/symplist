import type { AppAction } from "@/actions/types";
import "./register.tsx";
import { activeArtifactLinks, activeHandoff } from "./controller.ts";

/** Actions contributed by the sharing feature to the command registry (§10.2). */
export const sharingActions: readonly AppAction[] = [
  {
    id: "sharing.revoke_selected",
    label: "Revoke selected link",
    context: "app",
    group: "page",
    availability: () =>
      activeArtifactLinks()?.canRevoke
        ? { enabled: true }
        : { enabled: false, reason: "Focus an active artifact link first" },
    run: () => activeArtifactLinks()?.revoke(),
  },
  {
    id: "sharing.copy_prompt",
    label: "Copy prepared prompt",
    context: "app",
    group: "page",
    availability: () =>
      activeHandoff()?.canCopy
        ? { enabled: true }
        : { enabled: false, reason: "Open a handoff prompt first" },
    run: () => activeHandoff()?.copy(),
  },
  ...(
    [
      ["sharing.prepare_handoff", "Prepare handoff", "handoff"],
      ["sharing.manage_links", "Manage artifact links", "artifacts"],
      ["sharing.share_artifact", "Share artifact", "artifacts"],
    ] as const
  ).map(([id, label, destination]) => ({
    id,
    label,
    context: "app" as const,
    group: "page" as const,
    availability: ({ services }: Parameters<AppAction["availability"]>[0]) =>
      services.route?.taskId ? { enabled: true } : { enabled: false, reason: "Open a task first" },
    run: ({ services }: Parameters<AppAction["run"]>[0]) => {
      if (services.route?.taskId)
        services.navigate(`/tasks/${encodeURIComponent(services.route.taskId)}/${destination}`);
    },
  })),
];
