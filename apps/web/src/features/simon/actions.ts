import type { AppAction } from "@/actions/types";
import { activeChat } from "./controller.ts";

/** Actions contributed by the simon feature to the command registry (§10.2). */
export const simonActions: readonly AppAction[] = [
  {
    id: "simon.send_message",
    label: "Send message to Simon",
    context: "composer",
    group: "chat",
    defaultBinding: "mod+enter",
    availability: () =>
      activeChat()?.canSend()
        ? { enabled: true }
        : { enabled: false, reason: "Write a message first, or finish the pending request" },
    run: async () => {
      await activeChat()?.send();
    },
  },
  {
    id: "simon.stop",
    label: "Stop Simon's current run",
    context: "app",
    group: "chat",
    availability: () =>
      activeChat()?.canStop()
        ? { enabled: true }
        : { enabled: false, reason: "Simon is not running in this conversation" },
    run: async () => {
      await activeChat()?.stop();
    },
  },
];
