import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { type BufferedTopicEvent, TopicAccessDeniedError } from "@symplist/core/events";
import { SimonError, SimonRepository, SimonViews } from "@symplist/core/simon";
import { TopicRegistry } from "../realtime/topic-registry.ts";

/** Retain a contiguous newest tail; the UI can discard an incomplete prefix and use checkpoints. */
export function boundedSimonLive(events: readonly BufferedTopicEvent[]) {
  let bytes = 2; // JSON array brackets; count one conservative separator per retained event.
  let start = events.length;
  while (start > 0) {
    const next = Buffer.byteLength(JSON.stringify(events[start - 1])) + 1;
    if (bytes + next > 262_144) break;
    bytes += next;
    start -= 1;
  }
  return { live: events.slice(start), liveTruncated: start > 0 };
}

/** Production conversation ownership replaces the Phase C test-only topic stand-ins. */
@Injectable()
export class SimonTopics implements OnModuleInit {
  private readonly views: SimonViews;
  constructor(
    @Inject(SimonRepository) repository: SimonRepository,
    @Inject(TopicRegistry) private readonly topics: TopicRegistry,
  ) {
    this.views = new SimonViews(repository);
  }

  onModuleInit(): void {
    this.topics.registerAuthorizer({
      kind: "conversation",
      authorize: (socket, topic) => this.views.owns(socket.userId, topic.conversationId),
    });
    this.topics.registerSnapshotProvider({
      kind: "conversation",
      snapshot: async (socket, topic, live) => {
        const history = await this.views
          .conversation(socket.userId, topic.conversationId)
          .catch((error) => {
            if (error instanceof SimonError && error.code === "not_found")
              throw new TopicAccessDeniedError();
            throw error;
          });
        // Never replay an earlier run over the persisted history of its continuation or next turn.
        // The UI reduces this tail by run/message identity; it must not append it to saved text.
        const partial =
          history.activeRun === null
            ? []
            : live.filter((event) => {
                const data = event.data;
                return (
                  event.type === "chunk" &&
                  data !== null &&
                  typeof data === "object" &&
                  "runId" in data &&
                  data.runId === history.activeRun?.runId
                );
              });
        return { ...history, ...boundedSimonLive(partial) };
      },
    });
  }
}
