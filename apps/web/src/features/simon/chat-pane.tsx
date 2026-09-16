"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { SimonConversation } from "./conversation.tsx";
import { useSimon } from "./provider.tsx";

export interface ChatPaneProps {
  readonly taskId: string;
}
export function ChatPane({ taskId }: ChatPaneProps) {
  const store = useSimon();
  return store ? (
    <SimonConversation store={store} taskId={taskId} />
  ) : (
    <EmptyState
      align="center"
      title="No messages yet"
      description="Ask Simon about this task. He reads the page one section at a time and can update it for you."
    />
  );
}
