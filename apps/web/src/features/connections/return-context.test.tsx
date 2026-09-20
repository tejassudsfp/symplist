import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubNavigation } from "@/features/access/test-support";
import { ConnectionReturnTask } from "./return-context.tsx";
import { renderConnections, taskId } from "./test-support.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/connections",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
let location: ReturnType<typeof stubNavigation>;
beforeEach(() => {
  window.sessionStorage.clear();
  location = stubNavigation("/settings/connections");
});
afterEach(() => location.restore());

describe("task return after provider authorization", () => {
  it("retains only validated task navigation across the fixed callback", async () => {
    location.setPath(`/settings/connections?task=${taskId}&collection=later&key=never-store-this`);
    const view = renderConnections(<ConnectionReturnTask />);
    expect(await screen.findByRole("link", { name: /Return to task/ })).toHaveAttribute(
      "href",
      `/later/${taskId}`,
    );
    const stored = window.sessionStorage.getItem(window.sessionStorage.key(0) ?? "");
    expect(JSON.parse(stored ?? "{}")).toEqual({ taskId, collection: "later" });
    expect(stored).not.toContain("never-store-this");
    view.unmount();
    location.setPath("/settings/connections?result=connected");
    renderConnections(<ConnectionReturnTask />);
    expect(await screen.findByRole("link", { name: /Return to task/ })).toHaveAttribute(
      "href",
      `/later/${taskId}`,
    );
  });
  it("cannot turn a task return into an arbitrary redirect", async () => {
    location.setPath("/settings/connections?task=https://evil.example&collection=//evil.example");
    renderConnections(<ConnectionReturnTask />);
    await waitFor(() => expect(screen.queryByRole("link")).not.toBeInTheDocument());
    expect(window.sessionStorage.length).toBe(0);
  });
  it("does not read another account's saved task context", () => {
    window.sessionStorage.setItem(
      "symplist.connections.return.other-account.2",
      JSON.stringify({ taskId, collection: "now" }),
    );
    renderConnections(<ConnectionReturnTask />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("keeps current-context navigation working if storage is blocked", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    location.setPath(`/settings/connections?task=${taskId}`);
    renderConnections(<ConnectionReturnTask />);
    expect(await screen.findByRole("link", { name: /Return to task/ })).toHaveAttribute(
      "href",
      `/now/${taskId}`,
    );
    write.mockRestore();
  });
});
