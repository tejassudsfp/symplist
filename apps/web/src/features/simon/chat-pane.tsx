"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { SimonConversation } from "./conversation.tsx";
import { useSimonChat } from "./provider.tsx";

/**
 * The component the shell's chat slot mounts. It is imported with `next/dynamic` from
 * `feature-slots.tsx`, so none of the chat feature reaches the initial bundle of a browser that can never
 * use it.
 *
 * `taskId` is null for the workspace-wide conversation and a task id for a task's own.
 */
export interface ChatPaneProps {
  readonly taskId: string | null;
}

export function ChatPane({ taskId }: ChatPaneProps) {
  const store = useSimonChat();
  if (!store)
    return (
      <EmptyState
        align="center"
        title="Simon is not available here"
        description="The assistant runs on your machine. Install the Symplist desktop app to use it."
      />
    );
  return <SimonConversation store={store} taskId={taskId} />;
}

export default ChatPane;
