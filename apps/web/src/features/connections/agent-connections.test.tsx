import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admittedAccess, mayaMe, stubNavigation } from "@/features/access/test-support";
import { AgentConnections, grantStatus } from "./agent-connections.tsx";
import {
  deferred,
  fakeConnectionsApi,
  grant,
  id,
  renderConnections,
  secretMarker,
  taskId,
} from "./test-support.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/agents",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
let location: ReturnType<typeof stubNavigation>;
beforeEach(() => {
  location = stubNavigation("/settings/agents");
});
afterEach(() => {
  location.restore();
});

async function setupKey(api = fakeConnectionsApi()) {
  const user = userEvent.setup();
  const view = renderConnections(<AgentConnections />, api);
  await user.click(await screen.findByRole("button", { name: "Add connection" }));
  await user.type(screen.getByLabelText("Connection name"), "Research helper");
  return { ...view, user, connectionsApi: api };
}

describe("scoped incoming-agent connections", () => {
  it("drops a revealed secret immediately when access generation changes", async () => {
    const { user, store } = await setupKey();
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await screen.findByLabelText("One-time API key");
    act(() =>
      store.setMe(
        mayaMe({
          access: { ...admittedAccess, accessGeneration: admittedAccess.accessGeneration + 1 },
        }),
      ),
    );
    expect(screen.queryByLabelText("One-time API key")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(secretMarker);
  });
  it("loads the real provider under StrictMode and uses the configured server", async () => {
    renderConnections(<AgentConnections />);
    expect(await screen.findByLabelText("MCP server address")).toHaveValue(
      "https://api.example/mcp",
    );
    expect(await screen.findByText(/No agent connections yet/)).toBeInTheDocument();
  });
  it("starts with selected tasks and refuses an empty scope", async () => {
    const { user, connectionsApi } = await setupKey();
    expect(screen.getByLabelText("Selected tasks only")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByText(/Select at least one task/)).toBeInTheDocument();
    expect(connectionsApi.createKey).not.toHaveBeenCalled();
  });
  it("requires a useful name before sending", async () => {
    const { user, connectionsApi } = await setupKey();
    await user.clear(screen.getByLabelText("Connection name"));
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByText("Name this connection.")).toBeInTheDocument();
    expect(connectionsApi.createKey).not.toHaveBeenCalled();
  });
  it("creates only the selected scope and reveals the key deliberately", async () => {
    const { user, connectionsApi } = await setupKey();
    await user.click(await screen.findByLabelText("Plan a quiet weekend"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const key = await screen.findByLabelText("One-time API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveValue(secretMarker);
    expect(connectionsApi.createKey).toHaveBeenCalledWith(
      { name: "Research helper", scopes: ["tasks:read"], taskIds: [taskId] },
      expect.any(String),
      expect.any(AbortSignal),
    );
    await user.click(screen.getByRole("button", { name: "Reveal key" }));
    expect(key).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide key" }));
    expect(key).toHaveAttribute("type", "password");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
  it("makes all-task access deliberate and sends independent permission choices", async () => {
    const { user, connectionsApi } = await setupKey();
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByLabelText("Edit tasks and pages"));
    await user.click(screen.getByLabelText("Start Simon work"));
    expect(screen.getByText(/including tasks you create later/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await screen.findByLabelText("One-time API key");
    expect(connectionsApi.createKey).toHaveBeenCalledWith(
      { name: "Research helper", scopes: ["tasks:read", "tasks:write", "ai:run"], taskIds: null },
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it("clears the one-time secret only after explicit close confirmation", async () => {
    const { user } = await setupKey();
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await screen.findByLabelText("One-time API key");
    await user.click(screen.getByRole("button", { name: "Done — close key display" }));
    expect(
      await screen.findByRole("alertdialog", { name: "Close the one-time key?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I saved it — close" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("One-time API key")).not.toBeInTheDocument(),
    );
    expect(document.body.innerHTML).not.toContain(secretMarker);
  });
  it("copies once with success feedback without a provider request", async () => {
    const { user, connectionsApi } = await setupKey();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await screen.findByLabelText("One-time API key");
    await user.click(screen.getByRole("button", { name: "Copy key" }));
    expect(await screen.findByRole("button", { name: "Key copied" })).toBeInTheDocument();
    expect(write).toHaveBeenCalledWith(secretMarker);
    expect(connectionsApi.createKey).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });
  it("handles blocked clipboard without pretending the key was copied", async () => {
    const { user } = await setupKey();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("blocked"));
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await screen.findByLabelText("One-time API key");
    await user.click(screen.getByRole("button", { name: "Copy key" }));
    expect(await screen.findByText(/Reveal the key and copy it manually/)).toBeInTheDocument();
    expect(screen.queryByText("Key copied")).not.toBeInTheDocument();
    write.mockRestore();
  });
  it("freezes the lost-response intent, then offers revoke-and-replace on redacted replay", async () => {
    const createKey = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue({ id, expiresAt: Date.now() + 1000, secretUnavailable: true });
    const { user, connectionsApi } = await setupKey(fakeConnectionsApi({ createKey }));
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    await screen.findByRole("button", { name: "Check creation result" });
    expect(screen.getByLabelText("Connection name")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check creation result" }));
    expect(await screen.findByText("Key already issued")).toBeInTheDocument();
    expect(createKey.mock.calls[1]?.slice(0, 2)).toEqual(createKey.mock.calls[0]?.slice(0, 2));
    await user.click(screen.getByRole("button", { name: "Revoke and replace" }));
    expect(connectionsApi.revoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Revoke old key" }));
    expect(await screen.findByRole("button", { name: "Create API key" })).toBeInTheDocument();
    expect(connectionsApi.revoke).toHaveBeenCalledWith(
      id,
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it("does not publish a key after unmount", async () => {
    const result =
      deferred<Awaited<ReturnType<ReturnType<typeof fakeConnectionsApi>["createKey"]>>>();
    const { user, unmount } = await setupKey(
      fakeConnectionsApi({ createKey: vi.fn(() => result.promise) }),
    );
    await user.click(screen.getByLabelText("All current and future tasks"));
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    unmount();
    await act(async () =>
      result.resolve({ id, key: secretMarker, expiresAt: 1, secretUnavailable: false }),
    );
    expect(document.body.innerHTML).not.toContain(secretMarker);
  });
  it("shows permissions and metadata, and requires revoke confirmation", async () => {
    const user = userEvent.setup();
    const api = fakeConnectionsApi({
      grants: vi.fn(async () => ({ server: "https://api.example/mcp", grants: [grant] })),
    });
    renderConnections(<AgentConnections />, api);
    await screen.findByText(grant.name);
    const list = screen.getByRole("list", { name: "Authorized agents" });
    expect(list).toHaveTextContent("1 selected tasks");
    expect(list).toHaveTextContent("Not used yet");
    await user.click(screen.getByRole("button", { name: "Revoke Research helper" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke Research helper?" });
    expect(api.revoke).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Revoke connection" }));
    expect(await screen.findByText(/Agent connection revoked/)).toBeInTheDocument();
    expect(api.revoke).toHaveBeenCalledTimes(1);
  });
  it("labels expired and revoked credentials without confusing them with active ones", () => {
    expect(grantStatus({ ...grant, expiresAt: 4 }, 5)).toBe("Expired");
    expect(grantStatus({ ...grant, revokedAt: 2 }, 3)).toBe("Revoked");
    expect(grantStatus(grant, 3)).toBe("Connected");
  });
});
