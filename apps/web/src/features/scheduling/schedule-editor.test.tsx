import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScheduleEditor } from "./schedule-editor.tsx";
import { emptySchedule, schedulingTaskId, stubSchedulingApi } from "./test-support.ts";

describe("schedule editor", () => {
  it("has an accessible dialog, optional date, no automatic reminder and cancel never writes", async () => {
    const api = stubSchedulingApi();
    const close = vi.fn();
    render(
      <ScheduleEditor api={api} taskId={schedulingTaskId} onClose={close} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: "Deadline and reminders" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Deadline date")).toHaveValue("");
    expect(screen.getByText(/never add a reminder automatically/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(api.save).not.toHaveBeenCalled();
  });
  it("preserves the same retry key and draft after a failed save", async () => {
    const api = stubSchedulingApi({
      save: vi
        .fn()
        .mockRejectedValueOnce({ code: "network" })
        .mockResolvedValueOnce({ ...emptySchedule, version: 1 }),
    });
    const saved = vi.fn();
    render(
      <ScheduleEditor api={api} taskId={schedulingTaskId} onClose={vi.fn()} onSaved={saved} />,
    );
    await screen.findByLabelText("Deadline date");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Check your connection/);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(vi.mocked(api.save).mock.calls[0]?.[2]).toBe(vi.mocked(api.save).mock.calls[1]?.[2]);
  });
  it("requires the explicit server delivery preview for a new reminder", async () => {
    const api = stubSchedulingApi();
    render(
      <ScheduleEditor
        api={api}
        taskId={schedulingTaskId}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        addReminder
      />,
    );
    await screen.findByLabelText("Deadline date");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Preview delivery times" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(api.preview).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.save).toHaveBeenCalledWith(
      schedulingTaskId,
      expect.objectContaining({
        deadline: null,
        reminders: [
          expect.objectContaining({ rule: expect.objectContaining({ kind: "absolute" }) }),
        ],
      }),
      expect.any(String),
    );
  });
  it("reports a conflict and reloads the server version without auto-saving", async () => {
    const api = stubSchedulingApi({
      save: vi.fn().mockRejectedValue({ code: "schedule.conflict" }),
    });
    render(
      <ScheduleEditor api={api} taskId={schedulingTaskId} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await screen.findByLabelText("Deadline date");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/);
    await userEvent.click(screen.getByRole("button", { name: "Reload schedule" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(api.save).toHaveBeenCalledOnce();
  });
  it("shows a retryable loading failure and never writes after closing before load", async () => {
    const api = stubSchedulingApi({ get: vi.fn().mockRejectedValue({ code: "not_found" }) });
    render(
      <ScheduleEditor api={api} taskId={schedulingTaskId} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available/);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });
});
