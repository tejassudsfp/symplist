import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VaultApi } from "./api";
import { VaultGrantPicker } from "./grant-picker";
import { VaultItemEditor } from "./item-editor";
import { VaultKeyForm } from "./key-form";
import { VaultResetScreen } from "./reset-screen";
import { VaultScreen } from "./vault-screen";

vi.mock("@/features/access/session", () => ({
  useSession: () => ({ status: "signed_in", user: { email: "maya@example.com" } }),
}));
vi.mock("@/lib/realtime", () => ({ realtimeUrl: () => null }));
const id = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001";
const item = {
  id,
  version: 1,
  type: "secret" as const,
  title: "Personal API key",
  value: "fictional-private-marker",
  updatedAt: Date.now(),
};
function fake(overrides: Partial<VaultApi> = {}): VaultApi {
  return {
    status: vi.fn(async () => ({
      state: "unlocked" as const,
      minimumKeyLength: 12,
      idleExpiresAt: Date.now() + 300000,
    })),
    list: vi.fn(async () => ({
      items: [{ ...item, value: undefined }],
      nextCursor: null,
      idleExpiresAt: Date.now() + 300000,
    })),
    read: vi.fn(async () => item),
    setup: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(async () => undefined),
    touch: vi.fn(async () => ({ idleExpiresAt: Date.now() + 300000 })),
    save: vi.fn(async () => ({ id, version: 2 })),
    remove: vi.fn(),
    sendCode: vi.fn(async () => ({
      challengeId: id,
      purpose: "vault_reset" as const,
      expiresAt: Date.now() + 600000,
      resendAvailableAt: Date.now() + 60000,
      codeLength: 6,
    })),
    verify: vi.fn(async () => ({ authorizationId: id, expiresAt: Date.now() + 600000 })),
    reset: vi.fn(),
    grant: vi.fn(),
    ...overrides,
  };
}
describe("Vault screen briefs", () => {
  it("a save response after locking cannot reload plaintext", async () => {
    let resolve: ((value: { id: string; version: number }) => void) | undefined;
    const api = fake({
      save: vi.fn(
        () =>
          new Promise<{ id: string; version: number }>((r) => {
            resolve = r;
          }),
      ),
    });
    const user = userEvent.setup();
    render(<VaultScreen api={api} />);
    await user.click(await screen.findByRole("button", { name: "Add item" }));
    await user.type(screen.getByLabelText("Title"), "A late draft");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Lock vault" }));
    resolve?.({ id, version: 1 });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Unlock your vault" })).toBeInTheDocument(),
    );
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.read).not.toHaveBeenCalled();
  });
  it("grant picker requires deliberate selection, sends a bound handle request and paginates", async () => {
    const api = fake({
      list: vi
        .fn()
        .mockResolvedValueOnce({
          items: [{ ...item, value: undefined }],
          nextCursor: id,
          idleExpiresAt: Date.now() + 300000,
        })
        .mockResolvedValueOnce({ items: [], nextCursor: null, idleExpiresAt: Date.now() + 300000 }),
      grant: vi.fn(async () => ({ id, handle: { $vault: id }, expiresAt: Date.now() + 3600000 })),
    });
    const onGranted = vi.fn();
    const user = userEvent.setup();
    render(
      <VaultGrantPicker
        api={api}
        context={{ taskId: id, conversationId: id, toolSlug: "API_SEND", argumentPath: "/key" }}
        onGranted={onGranted}
        onCancel={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "Use this item" })).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "Load more items" }));
    expect(api.list).toHaveBeenLastCalledWith(id);
    await user.selectOptions(screen.getByRole("combobox"), id);
    await user.click(screen.getByRole("button", { name: "Use this item" }));
    expect(api.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: id,
        conversationId: id,
        toolSlug: "API_SEND",
        argumentPath: "/key",
        itemId: id,
        itemVersion: 1,
      }),
      expect.any(String),
    );
    expect(onGranted).toHaveBeenCalledWith({ $vault: id });
    expect(JSON.stringify(vi.mocked(api.grant).mock.calls)).not.toContain(item.value);
  });
  it("locked view never loads names, counts or values", async () => {
    const api = fake({
      status: vi.fn(async () => ({
        state: "locked" as const,
        minimumKeyLength: 12,
        idleExpiresAt: null,
      })),
    });
    render(<VaultScreen api={api} />);
    expect(await screen.findByRole("heading", { name: "Unlock your vault" })).toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Vault key")).toHaveAttribute("type", "password");
  });
  it("reveals deliberately, masks again and clears all plaintext on lock", async () => {
    const user = userEvent.setup();
    const api = fake();
    render(<VaultScreen api={api} />);
    await user.click(await screen.findByRole("button", { name: /Personal API key/ }));
    expect(screen.queryByText(item.value)).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Reveal secret" }));
    expect(screen.getByText(item.value)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide secret" }));
    expect(screen.queryByText(item.value)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lock vault" }));
    expect(await screen.findByRole("heading", { name: "Unlock your vault" })).toBeInTheDocument();
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    expect(api.lock).toHaveBeenCalledTimes(1);
  });
  it("searches unlocked titles and offers an empty state", async () => {
    const user = userEvent.setup();
    render(<VaultScreen api={fake()} />);
    await user.type(await screen.findByRole("searchbox"), "unmatched");
    expect(screen.getByText("No matching items.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Personal API key/ })).not.toBeInTheDocument();
  });
  it("ignores an item response arriving after lock", async () => {
    let resolve: ((value: typeof item) => void) | undefined;
    const api = fake({
      read: vi.fn(
        () =>
          new Promise<typeof item>((r) => {
            resolve = r;
          }),
      ),
    });
    const user = userEvent.setup();
    render(<VaultScreen api={api} />);
    await user.click(await screen.findByRole("button", { name: /Personal API key/ }));
    await user.click(screen.getByRole("button", { name: "Lock vault" }));
    resolve?.(item);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Unlock your vault" })).toBeInTheDocument(),
    );
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
  });
  it("key setup rejects mismatch/weak key without API calls and submits only deliberate valid input", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<VaultKeyForm mode="setup" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Create a vault key"), "short");
    await user.type(screen.getByLabelText("Confirm vault key"), "other");
    await user.click(screen.getByRole("button", { name: "Create vault" }));
    expect(screen.getByRole("alert")).toHaveTextContent("do not match");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Confirm vault key"));
    await user.type(screen.getByLabelText("Confirm vault key"), "short");
    await user.click(screen.getByRole("button", { name: "Create vault" }));
    expect(screen.getByRole("alert")).toHaveTextContent("12 characters");
  });
  it("preserves the editor draft on save failure, masks secrets and never echoes value in the error", async () => {
    const user = userEvent.setup();
    const api = fake({
      save: vi.fn(async () => {
        throw { code: "vault.conflict" };
      }),
    });
    render(
      <VaultItemEditor
        item={item}
        api={api}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        onLock={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Secret value");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, " edited");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("draft is kept");
    expect(input).toHaveValue(`${item.value} edited`);
    expect(screen.getByRole("alert")).not.toHaveTextContent(item.value);
  });
  it("reset distinguishes purpose, verifies fresh code then changes key", async () => {
    const user = userEvent.setup();
    const api = fake();
    const done = vi.fn();
    render(
      <VaultResetScreen
        api={api}
        email="maya@example.com"
        minimum={12}
        onBack={vi.fn()}
        onSuccess={done}
      />,
    );
    expect(screen.getByText(/contents are preserved/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(await screen.findByRole("heading", { name: "Verify vault reset" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await user.type(await screen.findByLabelText("New vault key"), "a new fictional key");
    await user.type(screen.getByLabelText("Confirm vault key"), "a new fictional key");
    await user.click(screen.getByRole("button", { name: "Reset vault key" }));
    expect(api.verify).toHaveBeenCalledWith(id, "123456");
    expect(done).toHaveBeenCalled();
  });
  it("a hidden tab clears content and unsaved drafts", async () => {
    const user = userEvent.setup();
    render(<VaultScreen api={fake()} />);
    await user.click(await screen.findByRole("button", { name: /Personal API key/ }));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Secret value")).toHaveValue(item.value);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("heading", { name: "Unlock your vault" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Secret value")).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
