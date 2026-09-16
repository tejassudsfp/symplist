import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotificationCenter, SnoozeDialog } from "./notification-center.tsx";
import { defaultPreferences, schedulingTaskId, stubSchedulingApi } from "./test-support.ts";

const complete = vi.hoisted(() => vi.fn());
vi.mock("@/features/workspace/controller", () => ({
  workspaceCommands: () => ({ commands: { complete } }),
}));
const notification = {
  id: "019947aa-0000-7000-8000-000000000002",
  taskId: schedulingTaskId,
  title: "Prepare outline",
  intendedAt: Date.parse("2026-09-17T09:00Z"),
  createdAt: Date.parse("2026-09-17T09:00Z"),
  quiet: true,
  late: true,
  kind: "missed" as const,
  count: 3,
  readAt: null,
  taskActive: true,
};
describe("persisted notification center", () => {
  it("has an empty state and does not toast or manufacture reminders on open", async () => {
    const api = stubSchedulingApi();
    const unread = vi.fn();
    render(<NotificationCenter api={api} onClose={vi.fn()} onUnread={unread} />);
    expect(await screen.findByRole("heading", { name: "All quiet here" })).toBeInTheDocument();
    expect(unread).toHaveBeenCalledWith(0);
    expect(api.mark).not.toHaveBeenCalled();
  });
  it("shows missed/quiet state, and marking read never completes the task", async () => {
    complete.mockClear();
    const api = stubSchedulingApi({
      notifications: vi.fn(async () => ({
        items: [notification],
        unreadCount: 1,
        nextCursor: null,
      })),
    });
    render(<NotificationCenter api={api} onClose={vi.fn()} onUnread={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Prepare outline" })).toBeInTheDocument();
    expect(screen.getByText(/3 missed reminders/)).toBeInTheDocument();
    expect(screen.getByText(/saved without a toast/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark read" }));
    expect(api.mark).toHaveBeenCalledWith(notification.id, "read", expect.any(String));
    expect(complete).not.toHaveBeenCalled();
  });
  it("disables task mutations on archived entries while dismissal remains available", async () => {
    const api = stubSchedulingApi({
      notifications: vi.fn(async () => ({
        items: [{ ...notification, taskActive: false }],
        unreadCount: 1,
        nextCursor: null,
      })),
    });
    render(<NotificationCenter api={api} onClose={vi.fn()} onUnread={vi.fn()} />);
    await screen.findByRole("heading", { name: "Prepare outline" });
    expect(screen.getByRole("button", { name: "Snooze" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark complete" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(api.mark).toHaveBeenCalledWith(notification.id, "dismiss", expect.any(String));
  });
  it("refreshes an already open center on the shared realtime revision", async () => {
    const api = stubSchedulingApi();
    const view = render(
      <NotificationCenter api={api} onClose={vi.fn()} onUnread={vi.fn()} refreshRevision={0} />,
    );
    await screen.findByRole("heading", { name: "All quiet here" });
    view.rerender(
      <NotificationCenter api={api} onClose={vi.fn()} onUnread={vi.fn()} refreshRevision={1} />,
    );
    await waitFor(() => expect(api.notifications).toHaveBeenCalledTimes(2));
  });
  it("uses the saved timezone for snooze and calls no deadline-editing API", async () => {
    const api = stubSchedulingApi({
      preferences: vi.fn(async () => ({
        ...defaultPreferences,
        data: { ...defaultPreferences.data, zone: "Asia/Kathmandu" },
      })),
    });
    const saved = vi.fn();
    render(<SnoozeDialog item={notification} api={api} onClose={vi.fn()} onSaved={saved} />);
    await waitFor(() => expect(screen.getByLabelText("Timezone")).toHaveValue("Asia/Kathmandu"));
    await userEvent.click(screen.getByRole("button", { name: "Tomorrow at 9" }));
    await userEvent.click(screen.getByRole("button", { name: "Snooze" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(api.snooze).toHaveBeenCalledWith(
      notification.id,
      expect.objectContaining({ zone: "Asia/Kathmandu", local: expect.stringMatching(/T09:00$/) }),
      expect.any(String),
    );
    expect(api.save).not.toHaveBeenCalled();
  });
});
