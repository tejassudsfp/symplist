import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SchedulingProvider } from "./provider.tsx";
import { defaultPreferences, stubSchedulingApi } from "./test-support.ts";

vi.mock("@/features/workspace/realtime", () => ({ workspaceRealtimeSource: () => null }));
describe("one-time onboarding timezone detection", () => {
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
