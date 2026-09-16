import { eventIdSchema } from "@symplist/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubNavigation } from "@/features/access/test-support";
import type { TopicHandlers } from "@/lib/realtime";
import { ServiceConnections } from "./service-connections.tsx";
import { deferred, fakeConnectionsApi, id, renderConnections, toolkit } from "./test-support.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/connections",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
let location: ReturnType<typeof stubNavigation>;
beforeEach(() => {
  location = stubNavigation("/settings/connections");
});
afterEach(() => {
  location.restore();
});

describe("service accounts and live catalogue", () => {
  it("survives the actual StrictMode provider lifecycle and loads catalogue only on demand", async () => {
    const api = fakeConnectionsApi();
    const user = userEvent.setup();
    renderConnections(<ServiceConnections />, api);
    expect(await screen.findByText(/No connected accounts yet/)).toBeInTheDocument();
    expect(api.catalogue).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Browse available services" }));
    expect(await screen.findByText("Gmail")).toBeInTheDocument();
    expect(screen.queryByText("Loading available services…")).not.toBeInTheDocument();
  });
  it("searches the live catalogue and announces no matches", async () => {
    const user = userEvent.setup();
    renderConnections(<ServiceConnections compact />);
    expect(await screen.findByText("Gmail")).toBeInTheDocument();
    // Compact starts with at most four examples; full view exposes the search.
    const api = fakeConnectionsApi({
      catalogue: vi.fn(async () => ({
        enabled: true,
        items: Array.from({ length: 8 }, (_, index) => ({
          ...toolkit,
          slug: `service${index}`,
          name: `Service ${index}`,
        })),
      })),
    });
    const other = renderConnections(<ServiceConnections compact />, api);
    await user.type(await screen.findByLabelText("Search services"), "missing");
    expect(screen.getByText(/No services match/)).toBeInTheDocument();
    other.unmount();
  });
  it("shows at most four onboarding examples until asked for more", async () => {
    const api = fakeConnectionsApi({
      catalogue: vi.fn(async () => ({
        enabled: true,
        items: Array.from({ length: 8 }, (_, index) => ({
          ...toolkit,
          slug: `service${index}`,
          name: `Service ${index}`,
        })),
      })),
    });
    renderConnections(<ServiceConnections compact />, api);
    const catalogue = await screen.findByRole("list", { name: "Service catalogue" });
    await waitFor(() => expect(within(catalogue).getAllByRole("listitem")).toHaveLength(4));
    await userEvent.setup().click(screen.getByRole("button", { name: "Show more services" }));
    expect(within(catalogue).getAllByRole("listitem")).toHaveLength(8);
  });
  it("does not offer broken tiles when connectors are disabled", async () => {
    const api = fakeConnectionsApi({
      list: vi.fn(async () => ({ enabled: false, connections: [] })),
    });
    renderConnections(<ServiceConnections compact />, api);
    expect(await screen.findByText("No connectors are set up here yet")).toBeInTheDocument();
    expect(api.catalogue).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "failed", "connected"])(
    "renders the %s callback without treating chat as approval",
    async (result) => {
      location.setPath(`/settings/connections?result=${result}`);
      renderConnections(<ServiceConnections />);
      expect(
        await screen.findByText(
          result === "connected"
            ? /connection was confirmed/
            : result === "cancelled"
              ? /Authorization was cancelled/
              : /could not be confirmed/,
        ),
      ).toBeInTheDocument();
    },
  );
  it("hands authorization to the provider and never collects its password", async () => {
    const user = userEvent.setup();
    const api = fakeConnectionsApi();
    const { navigate } = renderConnections(<ServiceConnections compact />, api);
    await user.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    await user.type(screen.getByLabelText("Account label (optional)"), "Personal");
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue to provider" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://provider.example/connect"));
    expect(api.start).toHaveBeenCalledWith(
      { toolkit: "gmail", alias: "Personal" },
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it("retries uncertain creation with the same input and key, then explains a redacted replay", async () => {
    const user = userEvent.setup();
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ attemptId: id, secretUnavailable: true, expiresAt: Date.now() });
    renderConnections(<ServiceConnections compact />, fakeConnectionsApi({ start }));
    await user.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    await user.click(screen.getByRole("button", { name: "Continue to provider" }));
    await user.click(await screen.findByRole("button", { name: "Check authorization result" }));
    expect(start.mock.calls[1]?.slice(0, 2)).toEqual(start.mock.calls[0]?.slice(0, 2));
    expect(await screen.findByText(/link was already issued/)).toBeInTheDocument();
  });
  it("reconnects the exact account, preserving its label", async () => {
    const user = userEvent.setup();
    const api = fakeConnectionsApi({
      list: vi.fn(async () => ({
        enabled: true,
        connections: [
          { id, toolkit: "gmail", alias: "Work", status: "needs_attention" as const, createdAt: 1 },
        ],
      })),
    });
    renderConnections(<ServiceConnections />, api);
    await user.click(await screen.findByRole("button", { name: "Manage Work" }));
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await user.click(screen.getByRole("button", { name: "Continue to provider" }));
    await waitFor(() =>
      expect(api.start).toHaveBeenCalledWith(
        { toolkit: "gmail", alias: "Work", replacesConnectionId: id },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
  });
  it("requires explicit disconnect confirmation and reports its real result", async () => {
    const user = userEvent.setup();
    const api = fakeConnectionsApi({
      list: vi.fn(async () => ({
        enabled: true,
        connections: [
          { id, toolkit: "gmail", alias: "Personal", status: "active" as const, createdAt: 1 },
        ],
      })),
    });
    renderConnections(<ServiceConnections />, api);
    await user.click(await screen.findByRole("button", { name: "Manage Personal" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(api.disconnect).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("alertdialog", { name: "Disconnect this account?" }),
    ).toHaveTextContent("not recalled");
    await user.click(screen.getByRole("button", { name: "Disconnect account" }));
    expect(await screen.findByText(/Account disconnected/)).toBeInTheDocument();
    expect(api.disconnect).toHaveBeenCalledTimes(1);
  });
  it("returns keyboard focus after closing provider details", async () => {
    const user = userEvent.setup();
    renderConnections(<ServiceConnections compact />);
    const opener = await screen.findByRole("button", { name: "Connect Gmail" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it("never navigates after the screen unmounts during creation", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof fakeConnectionsApi>["start"]>>>();
    const user = userEvent.setup();
    const api = fakeConnectionsApi({ start: vi.fn(() => pending.promise) });
    const result = renderConnections(<ServiceConnections compact />, api);
    await user.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    await user.click(screen.getByRole("button", { name: "Continue to provider" }));
    result.unmount();
    await act(async () =>
      pending.resolve({
        attemptId: id,
        expiresAt: 1,
        url: "https://provider.example",
        secretUnavailable: false,
      }),
    );
    expect(result.navigate).not.toHaveBeenCalled();
  });
  it("coalesces realtime connection hints and unsubscribes", async () => {
    let handlers: TopicHandlers | undefined;
    const off = vi.fn();
    const api = fakeConnectionsApi();
    const result = renderConnections(<ServiceConnections />, api, {
      realtime: {
        subscribeUser: (value) => {
          handlers = value;
          return off;
        },
      },
    });
    await screen.findByText(/No connected accounts yet/);
    const before = vi.mocked(api.list).mock.calls.length;
    for (let index = 0; index < 20; index++)
      handlers?.onEvent?.({
        t: "ev",
        topic: "user",
        seq: index,
        id: eventIdSchema.parse(`01929f3e-7c1a-7b2e-9a55-${String(index).padStart(12, "0")}`),
        type: "connection.status_changed",
        data: { connectionId: id },
      });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(before + 1));
    result.unmount();
    expect(off).toHaveBeenCalled();
  });
});
