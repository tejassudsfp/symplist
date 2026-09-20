import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDocuments } from "@/features/documents/fake-api";
import { ArtifactsManager } from "./artifacts-manager.tsx";
import { HandoffDraftError, type HandoffDraftInput } from "./handoff-draft.ts";
import { HandoffScreen, manualHandoffPrompt, setHandoffDraftHandler } from "./handoff-screen.tsx";
import { ShareDialog } from "./share-dialog.tsx";
import { SnapshotDialog } from "./snapshot-dialog.tsx";
import { artifact, fakeSharingApi, grant, release } from "./test-support.ts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/tasks/example/handoff",
}));
beforeEach(() => setHandoffDraftHandler(null));
afterEach(() => setHandoffDraftHandler(null));
describe("review and release", () => {
  it("does not mint on opening, defaults to 24-hour link and reveals only a successful release", async () => {
    const api = fakeSharingApi();
    const onReleased = vi.fn();
    render(
      <ShareDialog artifactId={artifact.id} api={api} onClose={vi.fn()} onReleased={onReleased} />,
    );
    await screen.findByText("Launch brief");
    expect(api.release).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Anyone with the link" })).toBeChecked();
    expect(screen.getByLabelText("Expires")).toHaveValue("24");
    await userEvent.click(screen.getByRole("button", { name: "Create expiring link" }));
    expect(api.release).toHaveBeenCalledWith(
      artifact.id,
      expect.objectContaining({ mode: "link", expectedHead: artifact.currentHead }),
      expect.any(String),
    );
    await screen.findByDisplayValue(release.secretUnavailable ? "" : release.url);
    expect(onReleased).toHaveBeenCalledWith(release);
  });
  it("requires explicit public confirmation and a separately supplied password", async () => {
    const api = fakeSharingApi();
    render(
      <ShareDialog artifactId={artifact.id} api={api} onClose={vi.fn()} onReleased={vi.fn()} />,
    );
    await screen.findByText("Launch brief");
    await userEvent.click(screen.getByRole("radio", { name: "Public artifact" }));
    expect(screen.getByRole("button", { name: "Publish read-only artifact" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /anyone can read/ }));
    expect(screen.getByRole("button", { name: "Publish read-only artifact" })).toBeEnabled();
    await userEvent.click(screen.getByRole("radio", { name: "Link and password" }));
    expect(screen.getByRole("button", { name: "Create expiring link" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Share password/), "separate-password");
    await userEvent.click(screen.getByRole("button", { name: "Create expiring link" }));
    expect(api.release).toHaveBeenCalledWith(
      artifact.id,
      expect.objectContaining({ mode: "password", password: "separate-password" }),
      expect.any(String),
    );
  });
  it("retains the same idempotency intent and exact expiry after a failed request", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(release);
    render(
      <ShareDialog
        artifactId={artifact.id}
        api={fakeSharingApi({ release: send })}
        onClose={vi.fn()}
        onReleased={vi.fn()}
      />,
    );
    await screen.findByText("Launch brief");
    await userEvent.click(screen.getByRole("button", { name: "Create expiring link" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Create expiring link" }));
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  });
  it("makes a redacted replay honest and never invents a copyable link", async () => {
    render(
      <ShareDialog
        artifactId={artifact.id}
        api={fakeSharingApi({
          release: vi.fn(async () => ({
            grant,
            secretUnavailable: true as const,
            notice: "secret.already_issued" as const,
          })),
        })}
        onClose={vi.fn()}
        onReleased={vi.fn()}
      />,
    );
    await screen.findByText("Launch brief");
    await userEvent.click(screen.getByRole("button", { name: "Create expiring link" }));
    await screen.findByText(/already issued/i);
    expect(screen.queryByRole("button", { name: /copy link/i })).not.toBeInTheDocument();
  });
  it("shows public-copy and stale-source warnings; replacement is an explicit new grant", async () => {
    const api = fakeSharingApi({
      preview: vi.fn(async () => ({
        artifact: { ...artifact, currentHead: "b".repeat(40) },
        markdown: "# Old version",
        hasPublicCopy: true,
      })),
    });
    render(
      <ShareDialog
        artifactId={artifact.id}
        api={api}
        replace={grant}
        onClose={vi.fn()}
        onReleased={vi.fn()}
      />,
    );
    await screen.findByText(/active public copy/);
    expect(screen.getByText(/older snapshot shown/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Revoke/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Create expiring link" }));
    expect(api.release).toHaveBeenCalledWith(
      artifact.id,
      expect.objectContaining({
        expectedHead: "b".repeat(40),
        replaceGrantId: grant.id,
        revokeReplaced: true,
      }),
      expect.any(String),
    );
  });
  it("Escape closes review without creating access", async () => {
    const api = fakeSharingApi();
    const close = vi.fn();
    render(<ShareDialog artifactId={artifact.id} api={api} onClose={close} onReleased={vi.fn()} />);
    await screen.findByText("Launch brief");
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
    expect(api.release).not.toHaveBeenCalled();
  });
});
describe("task snapshots and handoff", () => {
  it("keeps an edited prompt until replacement is explicitly confirmed", async () => {
    render(
      <HandoffScreen
        taskId={artifact.taskId}
        api={fakeSharingApi()}
        documents={new FakeDocuments({ taskId: artifact.taskId }).api}
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Editable prompt" });
    fireEvent.change(editor, { target: { value: "Keep these reviewed instructions" } });
    await userEvent.click(screen.getByRole("button", { name: "Start a manual draft" }));
    expect(editor).toHaveValue("Keep these reviewed instructions");
    await userEvent.keyboard("{Escape}");
    expect(editor).toHaveValue("Keep these reviewed instructions");
    await userEvent.click(screen.getByRole("button", { name: "Start a manual draft" }));
    await userEvent.click(screen.getByRole("button", { name: "Replace prompt" }));
    expect(editor).toHaveValue(manualHandoffPrompt(""));
  });
  it("supports empty and error states with no implied sharing", async () => {
    const view = render(
      <ArtifactsManager
        updatedAt={artifact.createdAt}
        taskId={artifact.taskId}
        headRevision={null}
        api={fakeSharingApi({
          list: vi.fn(async () => ({
            artifacts: [],
            grants: [],
            hasMore: false,
            nextArtifact: null,
            nextGrant: null,
          })),
        })}
      />,
    );
    await screen.findByText("No snapshots or links yet");
    expect(screen.getByRole("button", { name: "New snapshot" })).toBeDisabled();
    view.unmount();
    render(
      <ArtifactsManager
        updatedAt={artifact.createdAt}
        taskId={artifact.taskId}
        headRevision={artifact.currentHead}
        api={fakeSharingApi({ list: vi.fn().mockRejectedValue(new Error("offline")) })}
      />,
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });
  it("requires confirmation to revoke one independently managed grant", async () => {
    const api = fakeSharingApi({
      list: vi.fn(async () => ({
        artifacts: [artifact],
        grants: [
          grant,
          { ...grant, id: "other", mode: "public" as const, status: "expired" as const },
        ],
        hasMore: false,
        nextArtifact: null,
        nextGrant: null,
      })),
    });
    render(
      <ArtifactsManager
        updatedAt={artifact.createdAt}
        taskId={artifact.taskId}
        headRevision={artifact.currentHead}
        api={api}
      />,
    );
    await screen.findByText("Public — anyone can read");
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(api.revoke).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Revoke/ }));
    await waitFor(() =>
      expect(api.revoke).toHaveBeenCalledWith(artifact.id, grant.id, expect.any(String)),
    );
  });
  it("snapshots selected saved sections and never silently includes the draft", async () => {
    const documents = new FakeDocuments({
      taskId: artifact.taskId,
      commits: [{ markdown: "# First\nOne\n\n# Second\nTwo\n" }],
    });
    const api = fakeSharingApi();
    render(
      <SnapshotDialog
        taskId={artifact.taskId}
        documents={documents.api}
        api={api}
        onCreated={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText(/Unsaved editor changes are not included/);
    await userEvent.click(screen.getByRole("radio", { name: "Selected sections only" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "First" }));
    await userEvent.click(screen.getByRole("button", { name: /Create private snapshot/ }));
    expect(api.snapshot).toHaveBeenCalledWith(
      artifact.taskId,
      expect.objectContaining({ sectionIds: [expect.any(String)] }),
      expect.any(String),
    );
    expect(api.release).not.toHaveBeenCalled();
  });
  it("saves a private handoff with references, never access URLs or an external send", async () => {
    const documents = new FakeDocuments({
      taskId: artifact.taskId,
      commits: [{ markdown: "# Brief\nContext\n" }],
    });
    const api = fakeSharingApi();
    render(<HandoffScreen taskId={artifact.taskId} api={api} documents={documents.api} />);
    await screen.findByRole("checkbox", { name: /Launch brief/ });
    await userEvent.click(screen.getByRole("checkbox", { name: /Launch brief/ }));
    fireEvent.change(screen.getByLabelText("Editable prompt"), {
      target: { value: "## Objective\nReview the launch" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save private prompt" }));
    await screen.findByText(/Private prompt snapshot saved/);
    expect(api.handoff).toHaveBeenCalledWith(
      artifact.taskId,
      expect.objectContaining({
        prompt: "## Objective\nReview the launch",
        artifactIds: [artifact.id],
      }),
      expect.any(String),
    );
    expect(api.release).not.toHaveBeenCalled();
  });
  it("returns Simon's ordinary-turn draft to the editor with selected references only", async () => {
    const documents = new FakeDocuments({
      taskId: artifact.taskId,
      commits: [{ markdown: "# Secret source\nPRIVATE_DOCUMENT_PLAINTEXT\n" }],
    });
    const api = fakeSharingApi();
    const draft = "## Objective\nPrepare the launch\n\n## Open questions\nConfirm the date";
    const handler = vi.fn(async (_input: HandoffDraftInput) => draft);
    setHandoffDraftHandler(handler);
    render(<HandoffScreen taskId={artifact.taskId} api={api} documents={documents.api} />);
    await userEvent.type(await screen.findByLabelText("Desired outcome"), "Prepare the launch");
    await userEvent.click(screen.getByRole("checkbox", { name: /Launch brief/ }));
    await userEvent.click(screen.getByRole("button", { name: "Ask Simon to draft" }));
    await screen.findByText(/Draft ready/);
    expect(screen.getByRole("textbox", { name: "Editable prompt" })).toHaveValue(draft);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: artifact.taskId,
        revision: documents.head?.revision,
        target: "coding_assistant",
        outcome: "Prepare the launch",
        artifactIds: [artifact.id],
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(handler.mock.calls[0]?.[0])).not.toContain("PRIVATE_DOCUMENT_PLAINTEXT");
    expect(api.handoff).not.toHaveBeenCalled();
    expect(api.release).not.toHaveBeenCalled();
  });
  it("explains a bounded wait without claiming the still-running task turn failed", async () => {
    setHandoffDraftHandler(
      vi.fn(async () => {
        throw new HandoffDraftError("simon.handoff_timeout");
      }),
    );
    render(
      <HandoffScreen
        taskId={artifact.taskId}
        api={fakeSharingApi()}
        documents={
          new FakeDocuments({
            taskId: artifact.taskId,
            commits: [{ markdown: "# Brief\nContext\n" }],
          }).api
        }
      />,
    );
    await userEvent.type(await screen.findByLabelText("Desired outcome"), "Draft a plan");
    await userEvent.click(screen.getByRole("button", { name: "Ask Simon to draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/still in task chat/i);
    expect(screen.getByRole("button", { name: "Ask Simon to draft" })).toBeEnabled();
  });
  it("aborts only the surface wait when the handoff screen unmounts", async () => {
    let resolve: (draft: string) => void = () => {};
    let signal: AbortSignal | null = null;
    setHandoffDraftHandler(
      vi.fn(
        (input) =>
          new Promise<string>((done) => {
            signal = input.signal;
            resolve = done;
          }),
      ),
    );
    const rendered = render(
      <HandoffScreen
        taskId={artifact.taskId}
        api={fakeSharingApi()}
        documents={
          new FakeDocuments({
            taskId: artifact.taskId,
            commits: [{ markdown: "# Brief\nContext\n" }],
          }).api
        }
      />,
    );
    await userEvent.type(await screen.findByLabelText("Desired outcome"), "Draft a plan");
    await userEvent.click(screen.getByRole("button", { name: "Ask Simon to draft" }));
    await waitFor(() => expect(signal).not.toBeNull());
    rendered.unmount();
    const captured = signal as AbortSignal | null;
    if (!captured) throw new Error("draft signal not captured");
    expect(captured.aborted).toBe(true);
    resolve("## Objective\nLate response");
    await Promise.resolve();
  });
  it("has complete manual instructions without claiming a live destination integration", () => {
    const text = manualHandoffPrompt("Review this change");
    for (const heading of [
      "Objective",
      "Constraints",
      "Expected output",
      "Acceptance checks",
      "Open questions",
      "Return instructions",
    ])
      expect(text).toContain(heading);
    expect(text).toContain("Review this change");
    expect(text).toContain("do not authorize edits");
  });
});
