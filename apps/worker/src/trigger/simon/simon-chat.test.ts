import { describe, expect, it } from "vitest";
import { SIMON_CHAT_IDLE_SECONDS, simonChat } from "./simon-chat.ts";

describe("simon-chat session", () => {
  it("is registered under the Symplist conversation identity", () => {
    // The session is keyed on our conversation id, so a run is only ever the compute serving it.
    expect(simonChat.id).toBe("simon-chat");
  });

  it("keeps the idle window bounded", () => {
    // The window is what buys a warm follow-up instead of a cold continuation boot. It also holds
    // compute for its whole length, so it is deliberately short rather than "as long as possible".
    expect(SIMON_CHAT_IDLE_SECONDS).toBeGreaterThan(0);
    expect(SIMON_CHAT_IDLE_SECONDS).toBeLessThanOrEqual(300);
  });
});
