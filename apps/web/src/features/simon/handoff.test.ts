import { describe, expect, it } from "vitest";
import { handoffDraftFingerprint, handoffDraftMessage } from "./handoff.ts";

const input = (signal: AbortSignal) => ({
  taskId: "01995000-0000-7000-8000-000000000001",
  revision: "a".repeat(40),
  target: "coding_assistant" as const,
  outcome: "Build the smallest verified implementation",
  artifactIds: ["01995000-0000-7000-8000-000000000002"],
  signal,
});

describe("Simon handoff request", () => {
  it("contains only explicit references and asks for a complete editable structure", () => {
    const message = handoffDraftMessage(input(new AbortController().signal));
    expect(message).toContain("Build the smallest verified implementation");
    expect(message).toContain("a".repeat(40));
    expect(message).toContain("01995000-0000-7000-8000-000000000002");
    expect(message).not.toContain("PRIVATE_DOCUMENT_PLAINTEXT_MARKER");
    for (const heading of [
      "Objective",
      "Instructions",
      "Constraints",
      "Supplied context",
      "Expected output",
      "Acceptance checks",
      "Open questions",
      "Return instructions",
    ])
      expect(message).toContain(heading);
    expect(message).toContain("creates no artifact, proposal, grant, link, or external send");
  });

  it("does not put lifecycle-only abort signals into the resumable request identity", () => {
    expect(handoffDraftFingerprint(input(new AbortController().signal))).toBe(
      handoffDraftFingerprint(input(new AbortController().signal)),
    );
  });
});
