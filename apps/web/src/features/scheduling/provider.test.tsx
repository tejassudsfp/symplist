import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useCallback, useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import { SchedulingProvider, useScheduling } from "./provider.tsx";
import { defaultPreferences, stubSchedulingApi } from "./test-support.ts";

vi.mock("@/features/workspace/realtime", () => ({ workspaceRealtimeSource: () => null }));
describe("one-time onboarding timezone detection", () => {
  it("loads mounted deadline subscriptions after Strict Mode cleanup and restart", async () => {
    function Probe() {
      const scheduling = useScheduling();
      if (!scheduling) throw new Error("Missing scheduling provider");
      const { deadlines } = scheduling;
      const subscribe = useCallback(
        (listener: () => void) => deadlines.subscribe("task", listener),
        [deadlines],
      );
      const snapshot = useSyncExternalStore(
        subscribe,
        () => deadlines.get("task"),
        () => null,
      );
      return <output>{snapshot ? `Version ${snapshot.version}` : "Loading deadline"}</output>;
    }
    const api = stubSchedulingApi({
      summaries: vi.fn(async (ids: readonly string[]) =>
        ids.map((taskId) => ({ taskId, version: 7, deadline: null, deadlineAt: null })),
      ),
    });
    render(
      <StrictMode>
        <SchedulingProvider api={api} userId="owner">
          <Probe />
        </SchedulingProvider>
      </StrictMode>,
    );
    expect(await screen.findByText("Version 7")).toBeInTheDocument();
    expect(api.summaries).toHaveBeenCalledExactlyOnceWith(["task"]);
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledOnce());
  });
  it("initializes only a missing preference row and does not create a reminder", async () => {
    const api = stubSchedulingApi();
    render(
      <SchedulingProvider api={api} userId="owner">
        <span>Workspace</span>
      </SchedulingProvider>,
    );
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledOnce());
    expect(api.savePreferences).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        email: false,
      }),
      expect.any(String),
    );
    expect(api.save).not.toHaveBeenCalled();
  });
  it("never overwrites a returning user's timezone after travel", async () => {
    const api = stubSchedulingApi({
      preferences: vi.fn(async () => ({
        ...defaultPreferences,
        version: 4,
        data: { ...defaultPreferences.data, zone: "Asia/Kathmandu" },
      })),
    });
    render(
      <SchedulingProvider api={api} userId="owner">
        <span>Workspace</span>
      </SchedulingProvider>,
    );
    await waitFor(() => expect(api.preferences).toHaveBeenCalledOnce());
    expect(api.savePreferences).not.toHaveBeenCalled();
  });
  it("does not make preference requests when signed out", () => {
    const api = stubSchedulingApi();
    render(
      <SchedulingProvider api={api} userId={null}>
        <span>Workspace</span>
      </SchedulingProvider>,
    );
    expect(api.preferences).not.toHaveBeenCalled();
    expect(api.savePreferences).not.toHaveBeenCalled();
  });
});
