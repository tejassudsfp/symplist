import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import AppRouteError from "./(app)/error.tsx";
import AppRouteLoading from "./(app)/loading.tsx";
import RouteError from "./error.tsx";
import Loading from "./loading.tsx";
import NotFound from "./not-found.tsx";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("route-level system states", () => {
  it.each([
    ["root", RouteError],
    ["app", AppRouteError],
  ] as const)("focuses the %s failure and retries only on request", async (_name, Boundary) => {
    const reset = vi.fn();
    render(<Boundary error={new Error("private stack marker")} reset={reset} />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveFocus();
    expect(screen.queryByText(/private stack marker/)).not.toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Try this/ }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it.each([Loading, AppRouteLoading])(
    "announces route loading without a blocking spinner",
    (RouteLoadingState) => {
      render(<RouteLoadingState />);
      expect(screen.getByRole("heading", { name: "Opening this page" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Loading this page");
      expect(document.querySelector(".sym-spinner")).toBeNull();
    },
  );

  it("uses a privacy-safe not-found state with a task-list exit", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to tasks" })).toHaveAttribute("href", "/now");
    expect(document.body).not.toHaveTextContent("Maya");
  });
});
