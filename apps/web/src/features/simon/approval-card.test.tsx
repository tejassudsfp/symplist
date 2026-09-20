import { simonApprovalViewSchema } from "@symplist/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "./approval-card.tsx";
import { emptyProjection } from "./projection.ts";
import type { ChatState, SimonStore } from "./store.ts";

const id = "01995000-0000-7000-8000-000000000001";
const state: ChatState = {
  taskId: id,
  conversationId: id,
  projection: emptyProjection,
  draft: "",
  tier: "fast",
  loading: false,
  loadingOlder: false,
  busy: false,
  error: null,
  uncertain: false,
  connection: "open",
  approval: simonApprovalViewSchema.parse({
    id,
    runId: id,
    toolCallId: "call_send",
    toolSlug: "GMAIL_SEND_EMAIL",
    connectionId: id,
    connectedAccountId: "ca_private_provider_identifier",
    connectionToolkit: "gmail",
    connectionAlias: "Maya’s work inbox",
    connectionGeneration: 1,
    status: "pending",
    argDigest: "a".repeat(43),
    arguments: { recipient: "friend@example.test" },
    preview: { recipient: "friend@example.test" },
    expiresAt: Date.now() + 60_000,
    policyVersion: "test.1",
  }),
  ask: null,
};

describe("Simon approval identity", () => {
  it("names the concrete action and user-recognizable service account without provider ids", () => {
    render(<ApprovalCard state={state} store={{} as SimonStore} />);
    expect(screen.getByText("Send email")).toBeInTheDocument();
    expect(screen.getByText("Maya’s work inbox · Gmail")).toBeInTheDocument();
    expect(screen.queryByText("ca_private_provider_identifier")).not.toBeInTheDocument();
  });
});
