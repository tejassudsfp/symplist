import { simonApprovalViewSchema } from "@symplist/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "./approval-card.tsx";
import { emptyProjection } from "./projection.ts";
import type { ChatState, SimonStore } from "./store.ts";

const id = "01995000-0000-7000-8000-000000000001";
function chatState(action?: { arguments: Record<string, unknown> }): ChatState {
  return {
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
      arguments: action?.arguments ?? { recipient: "friend@example.test" },
      preview: { recipient: "friend@example.test" },
      expiresAt: Date.now() + 60_000,
      policyVersion: "test.1",
    }),
    ask: null,
  };
}
const state = chatState();
function disclosure(): HTMLDetailsElement {
  const details = screen
    .getByText("Exact action fields", { selector: "summary" })
    .closest("details");
  if (!details) throw new Error("the approval card has no exact-fields disclosure");
  return details;
}

describe("Simon approval identity", () => {
  it("leads with a plain-language summary of the proposed action", () => {
    render(<ApprovalCard state={state} store={{} as SimonStore} />);
    expect(
      screen.getByRole("heading", { name: "Send an email to friend@example.test" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Using Maya’s work inbox · Gmail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve action" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Don’t do this" })).toBeInTheDocument();
  });

  it("names the concrete action and user-recognizable service account without provider ids", () => {
    render(<ApprovalCard state={state} store={{} as SimonStore} />);
    expect(screen.getByText("Send email")).toBeInTheDocument();
    expect(screen.getByText("Maya’s work inbox · Gmail")).toBeInTheDocument();
    expect(screen.queryByText("ca_private_provider_identifier")).not.toBeInTheDocument();
  });

  it("keeps the raw arguments out of the default surface", () => {
    render(<ApprovalCard state={state} store={{} as SimonStore} />);
    const details = disclosure();
    expect(details).not.toHaveAttribute("open");
    expect(details).toContainElement(screen.getByRole("textbox", { name: "Exact action fields" }));
    expect(details).toContainElement(screen.getByRole("textbox", { name: "Action preview" }));
    expect(details).toContainElement(screen.getByRole("button", { name: "Edit draft" }));
  });

  it("makes scrollable approval payloads keyboard reachable through the disclosure", () => {
    render(<ApprovalCard state={state} store={{} as SimonStore} />);
    // jsdom implements no summary activation, so the disclosure opens the way a browser opens it.
    disclosure().open = true;

    const exact = screen.getByRole("textbox", { name: "Exact action fields" });
    expect(exact).toHaveAttribute("readonly");
    expect(exact).toHaveValue(JSON.stringify({ recipient: "friend@example.test" }, null, 2));
    expect(screen.getByRole("textbox", { name: "Action preview" })).toHaveAttribute("readonly");
  });

  it("leaves edit mode with the disclosure, so a decision is always on screen", async () => {
    render(<ApprovalCard state={state} store={{} as SimonStore} />);
    const details = disclosure();
    details.open = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit draft" }));
    expect(screen.getByRole("textbox", { name: "Edited action fields" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve action" })).not.toBeInTheDocument();

    details.open = false;

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve action" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("textbox", { name: "Edited action fields" })).not.toBeInTheDocument();
  });

  it("never renders a vault value, only the grant standing in for it", () => {
    render(
      <ApprovalCard
        state={chatState({
          arguments: { recipient: { $vault: "vgh_never_rendered" }, subject: "Quarterly report" },
        })}
        store={{} as SimonStore}
      />,
    );
    disclosure().open = true;

    expect(
      screen.getByRole("heading", { name: "Send an email to 1 recipient" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Exact action fields" })).toHaveValue(
      JSON.stringify(
        { recipient: { $vault: "Limited vault grant" }, subject: "Quarterly report" },
        null,
        2,
      ),
    );
    for (const box of screen.getAllByRole("textbox"))
      expect((box as HTMLTextAreaElement).value).not.toContain("vgh_never_rendered");
    expect(document.body.textContent).not.toContain("vgh_never_rendered");
  });
});
