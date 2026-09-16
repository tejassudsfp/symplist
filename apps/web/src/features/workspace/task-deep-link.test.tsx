import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceApi } from "./api.ts";
import { TaskDeepLink } from "./task-deep-link.tsx";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
describe("stable authenticated task links", () => {
  it.each(["now", "later", "unclassified", "archived"])(
    "resolves the current %s location rather than an old email location",
    async (location) => {
      navigation.replace.mockClear();
      const getTask = vi.fn(async () => ({
        task: {
          id: "task",
          status: location === "archived" ? "archived" : "active",
          collection: location === "archived" ? "now" : location,
        },
      })) as unknown as WorkspaceApi["getTask"];
      render(<TaskDeepLink taskId="task" api={{ getTask }} />);
      await waitFor(() =>
        expect(navigation.replace).toHaveBeenCalledWith(
          `/${location === "archived" ? "archive" : location}/task`,
        ),
      );
      expect(getTask).toHaveBeenCalledWith("task");
    },
  );
  it("does not redirect to another task or expose content after a denied read", async () => {
    navigation.replace.mockClear();
    render(
      <TaskDeepLink
        taskId="foreign"
        api={{ getTask: vi.fn().mockRejectedValue({ code: "not_found" }) }}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/may no longer be available/);
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
