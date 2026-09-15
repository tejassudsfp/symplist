"use client";

import { EmptyState } from "@/components/ui/empty-state";

export interface ChatPaneProps {
  /** The selected task. The shell mounts a fresh pane for each task. */
  readonly taskId: string;
}

/**
 * The selected task's conversation with Simon, shown in the shell's chat frame (§2.3). PLACEHOLDER:
 * the Simon feature replaces this body with the messages and composer (§8); until then it shows the
 * chat frame's empty state.
 */
export function ChatPane(_props: ChatPaneProps) {
  return (
    <EmptyState
      align="center"
      title="No messages yet"
      description="Ask Simon about this task. He reads the page one section at a time and can update it for you."
    />
  );
}
