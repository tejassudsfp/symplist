import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TaskScope } from "./task-scope.tsx";
import { fakeConnectionsApi, renderConnections, taskId } from "./test-support.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/agents",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
function Harness({ initial = [] }: { initial?: string[] }) {
  const [value, setValue] = useState<string[] | null>(initial);
  return <TaskScope value={value} onChange={setValue} />;
}
describe("bounded, deliberate task selection", () => {
  it("loads another collection only when selected, and retains prior selections", async () => {
    const api = fakeConnectionsApi();
    const user = userEvent.setup();
    renderConnections(<Harness />, api);
    await user.click(await screen.findByLabelText("Plan a quiet weekend"));
    expect(screen.getByText("1 of 100 tasks selected")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Task collection"), "later");
    await waitFor(() =>
      expect(api.tasks).toHaveBeenCalledWith("later", null, expect.any(AbortSignal)),
    );
    expect(await screen.findByLabelText("Plan a quiet weekend")).toBeChecked();
  });
  it("uses explicit cursor pages rather than fanning out reads", async () => {
    const api = fakeConnectionsApi();
    const base = await api.tasks("now", null, new AbortController().signal);
    api.tasks = vi.fn(async (_collection, cursor) => ({
      ...base,
      nextCursor: cursor ? null : "next-page",
      tasks: base.tasks.map((task) => ({ ...task, title: cursor ? "Next task" : task.title })),
    }));
    const user = userEvent.setup();
    renderConnections(<Harness />, api);
    await user.click(await screen.findByLabelText("Plan a quiet weekend"));
    expect(vi.mocked(api.tasks).mock.calls.every((call) => call[1] === null)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next task page" }));
    expect(await screen.findByLabelText("Next task")).toBeChecked();
    expect(api.tasks).toHaveBeenLastCalledWith("now", "next-page", expect.any(AbortSignal));
    await user.click(screen.getByRole("button", { name: "First task page" }));
    expect(await screen.findByLabelText("Plan a quiet weekend")).toBeChecked();
  });
  it("caps selection at 100 and still allows clearing it", async () => {
    const ids = Array.from(
      { length: 100 },
      (_, index) => `01929f3e-7c1a-7b2e-9a55-${String(index).padStart(12, "0")}`,
    );
    renderConnections(<Harness initial={ids} />);
    expect(await screen.findByLabelText("Plan a quiet weekend")).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear task selection" }));
    expect(screen.getByLabelText("Plan a quiet weekend")).toBeEnabled();
    expect(screen.getByText("0 of 100 tasks selected")).toBeInTheDocument();
  });
  it("filters loaded tasks without issuing new search requests", async () => {
    const api = fakeConnectionsApi();
    renderConnections(<Harness initial={[taskId]} />, api);
    await screen.findByLabelText("Plan a quiet weekend");
    const before = vi.mocked(api.tasks).mock.calls.length;
    await userEvent.setup().type(screen.getByLabelText("Filter loaded tasks"), "no-match");
    expect(screen.getByText("No matching tasks on this page.")).toBeInTheDocument();
    expect(api.tasks).toHaveBeenCalledTimes(before);
  });
});
