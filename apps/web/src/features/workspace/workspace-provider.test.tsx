import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { ToastProvider } from "@/components/ui/toast";
import { FakeWorkspaceApi } from "./test-support.tsx";
import {
  usePreferenceGroup,
  usePreferencesStatus,
  useTaskCollection,
  useWorkspace,
  WorkspaceProvider,
} from "./workspace-provider.tsx";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/now", useRouter: () => router }));

function Probe() {
  const tasks = useTaskCollection("now");
  const { preferences } = useWorkspace();
  const status = usePreferencesStatus(preferences);
  const appearance = usePreferenceGroup(preferences, "appearance");
  return (
    <output>
      {tasks.status}/{status}/{tasks.tasks[0]?.title}/{appearance.data.themeId}
    </output>
  );
}

it("keeps memoized workspace stores alive through Strict Mode effect replay", async () => {
  const api = new FakeWorkspaceApi([{ id: "task", title: "A real task" }]);
  api.setPreference("appearance", { themeId: "paper", mode: "dark", accent: "violet" }, 3);
  render(
    <StrictMode>
      <StatusAnnouncerProvider>
        <ToastProvider>
          <WorkspaceProvider api={api} realtime={null} userId="owner">
            <Probe />
          </WorkspaceProvider>
        </ToastProvider>
      </StatusAnnouncerProvider>
    </StrictMode>,
  );
  expect(await screen.findByText("ready/ready/A real task/paper")).toBeInTheDocument();
  expect(api.calls.filter((call) => call.method === "getPreferences")).toHaveLength(1);
  expect(api.calls.filter((call) => call.method === "listTasks")).toHaveLength(1);
});
