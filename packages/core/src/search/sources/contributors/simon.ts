import type { SearchSourceContributor } from "../types.ts";

/**
 * Simon's search source (§8, §10.1). It adds `messages`: a `MessageTextSource` over persisted
 * task-conversation messages (never quick chats). Until it does, there are no messages to index.
 */
export const simonSearchSourceContributor: SearchSourceContributor = {
  domain: "simon",
};
