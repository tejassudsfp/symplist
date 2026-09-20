import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotificationSettings } from "./settings.tsx";
import { defaultPreferences, stubSchedulingApi } from "./test-support.ts";

describe("notification preferences", () => {
  it("loads private defaults and explains channel cancellation and essential security mail", async () => {
    const api = stubSchedulingApi();
    render(<NotificationSettings api={api} />);
    expect(await screen.findByLabelText("Timezone")).toHaveValue("UTC");
    expect(screen.getByLabelText("Reminder email")).not.toBeChecked();
    expect(screen.getByLabelText("Include task titles in reminder emails")).not.toBeChecked();
    expect(screen.getByText(/Turning it back on does not/)).toBeInTheDocument();
    expect(screen.getByText(/never disable sign-in/)).toBeInTheDocument();
    expect(api.savePreferences).not.toHaveBeenCalled();
  });
  it("saves opt-in and privacy only through the trusted UI and retains retry identity", async () => {
    const api = stubSchedulingApi({
      savePreferences: vi
        .fn()
        .mockRejectedValueOnce({ code: "network" })
        .mockResolvedValueOnce({
          ...defaultPreferences,
          version: 1,
          data: { ...defaultPreferences.data, email: true },
        }),
    });
    render(<NotificationSettings api={api} />);
    await screen.findByLabelText("Timezone");
    await userEvent.click(screen.getByLabelText("Reminder email"));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Reminder email")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Notification settings saved."),
    );
    expect(vi.mocked(api.savePreferences).mock.calls[0]?.[2]).toBe(
      vi.mocked(api.savePreferences).mock.calls[1]?.[2],
    );
  });
  it("shows server-level disabled states without disabling security mail", async () => {
    render(
      <NotificationSettings
        api={stubSchedulingApi({
          preferences: vi.fn(async () => ({
            ...defaultPreferences,
            remindersEnabled: false,
            emailEnabled: false,
          })),
        })}
      />,
    );
    await screen.findByLabelText("Timezone");
    expect(screen.getByLabelText("Reminder email")).toBeDisabled();
    expect(screen.getByText(/All reminders are disabled/)).toBeInTheDocument();
  });
});
