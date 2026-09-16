import { conversationIdSchema } from "@symplist/contracts";
import { workspaceRealtimeClient } from "@/features/workspace/realtime";
import type { RealtimeStatus, TopicHandlers } from "@/lib/realtime";

export interface SimonRealtime {
  subscribe(
    id: string,
    handlers: TopicHandlers,
    status: (value: RealtimeStatus) => void,
  ): () => void;
}
export const simonRealtime: SimonRealtime = {
  subscribe(id, handlers, status) {
    const client = workspaceRealtimeClient();
    if (!client) {
      status("offline");
      return () => {};
    }
    const subscription = client.subscribeConversation(conversationIdSchema.parse(id), handlers);
    const off = client.onStatusChange(status);
    client.connect();
    return () => {
      subscription.unsubscribe();
      off();
    };
  },
};
