import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import { EmptyState, PageIllustration, ThemeIllustration } from "./empty-state.tsx";
import { InlineError } from "./inline-error.tsx";
import { SaveStatus, saveStatusText } from "./save-status.tsx";
import { Skeleton, SkeletonLines } from "./skeleton.tsx";
import { Spinner } from "./spinner.tsx";
import {
  ANNOUNCEMENT_CLEAR_MS,
  StatusAnnouncerProvider,
  useAnnouncer,
} from "./status-announcer.tsx";
import {
  TOAST_DURATION_MS,
  TOAST_WITH_ACTION_DURATION_MS,
  ToastProvider,
  useToast,
} from "./toast.tsx";
import { HintTooltip, TooltipProvider } from "./tooltip.tsx";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConfirmDialog", () => {
  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Complete task
        </button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Complete this task and its 2 subtasks?"
          description="Open subtasks are archived with it."
          confirmLabel="Complete all 3"
          onConfirm={() => {
            onConfirm();
            setOpen(false);
          }}
        />
        <button type="button">Outside</button>
      </>
    );
  }

  it("moves focus inside, traps Tab, closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "Complete task" });
    await user.click(opener);
    const dialog = await screen.findByRole("alertdialog", {
      name: "Complete this task and its 2 subtasks?",
    });
    expect(dialog).toHaveAttribute("data-action-layer", "modal");
    expect(dialog).toHaveAccessibleDescription("Open subtasks are archived with it.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("button", { name: "Complete all 3" })).toHaveFocus();
    await user.tab();
    // Tabbing past the last control wraps to the first one instead of leaving the dialog.
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Content outside a modal dialog is hidden from assistive technology while it is open.
    expect(screen.queryByRole("button", { name: "Outside" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside", hidden: true })).not.toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("runs the confirm action only when confirmed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Complete task" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Complete task" }));
    await user.click(await screen.findByRole("button", { name: "Complete all 3" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("DropdownMenu", () => {
  it("opens from the keyboard, navigates with arrows, and returns focus on Escape", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Task menu</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Task actions">
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive}>
            Complete
            <DropdownMenuShortcut spoken="X">X</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole("button", { name: "Task menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-action-layer", "menu");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Complete/ })).toHaveFocus());
    expect(screen.getByRole("menuitem", { name: /Complete/ })).toHaveAccessibleName(
      /^Complete ?\(shortcut X\)$/,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onArchive).not.toHaveBeenCalled();
  });
});

describe("HintTooltip", () => {
  it("shows its hint on keyboard focus without replacing the control's name", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={0}>
        <HintTooltip label="Later" shortcut="G then L">
          <button type="button" aria-label="Later">
            icon
          </button>
        </HintTooltip>
      </TooltipProvider>,
    );
    await user.tab();
    const button = screen.getByRole("button", { name: "Later" });
    expect(button).toHaveFocus();
    expect(await screen.findByText("G then L")).toBeInTheDocument();
    expect(button).toHaveAccessibleName("Later");
  });
});

describe("Toast", () => {
  function Buttons() {
    const toast = useToast();
    return (
      <>
        <button
          type="button"
          onClick={() =>
            toast.show({ message: "Moved to Later", action: { label: "Undo", onAction: undo } })
          }
        >
          move
        </button>
        <button
          type="button"
          onClick={() =>
            toast.show({
              message: "Couldn't move it. It's back where it was.",
              action: { label: "Try again", onAction: retry },
            })
          }
        >
          fail
        </button>
        <button type="button" onClick={() => toast.show({ message: "Saved" })}>
          plain
        </button>
      </>
    );
  }
  const undo = vi.fn();
  const retry = vi.fn();

  it("announces one toast at a time in a persistent live region, with Undo and Try again", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Buttons />
      </ToastProvider>,
    );
    const region = document.querySelector('[data-slot="toast-region"] [role="status"]');
    expect(region).toHaveAttribute("aria-live", "polite");
    await user.click(screen.getByRole("button", { name: "move" }));
    expect(region).toHaveTextContent("Moved to Later");
    await user.click(screen.getByRole("button", { name: "fail" }));
    expect(region).not.toHaveTextContent("Moved to Later");
    expect(region).toHaveTextContent("Couldn't move it.");
    expect(screen.getAllByRole("button", { name: /Undo|Try again/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(region).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "move" }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "plain" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(region).toBeEmptyDOMElement();
  });

  it("auto-dismisses, gives action toasts longer, pauses on focus and closes on Escape", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Buttons />
      </ToastProvider>,
    );
    const region = document.querySelector(
      '[data-slot="toast-region"] [role="status"]',
    ) as HTMLElement;
    act(() => screen.getByRole("button", { name: "plain" }).click());
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 10));
    expect(region).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(20));
    expect(region).toBeEmptyDOMElement();

    act(() => screen.getByRole("button", { name: "move" }).click());
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS + 100));
    expect(region).toHaveTextContent("Moved to Later");
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() => vi.advanceTimersByTime(TOAST_WITH_ACTION_DURATION_MS * 3));
    expect(region).toHaveTextContent("Moved to Later");
    act(() => {
      screen
        .getByRole("button", { name: "Undo" })
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(region).toBeEmptyDOMElement();
  });

  it("requires its provider", () => {
    const Orphan = () => {
      useToast();
      return null;
    };
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
  });
});

describe("StatusAnnouncer", () => {
  function Announce({
    message,
    politeness,
  }: {
    message: string;
    politeness?: "polite" | "assertive";
  }) {
    const { announce } = useAnnouncer();
    return (
      <button type="button" onClick={() => announce(message, politeness)}>
        {`announce ${message}`}
      </button>
    );
  }

  it("announces politely or assertively, repeats identical messages and clears later", async () => {
    vi.useFakeTimers();
    render(
      <StatusAnnouncerProvider>
        <Announce message="Saved" />
        <Announce message="Couldn't save" politeness="assertive" />
      </StatusAnnouncerProvider>,
    );
    const polite = document.querySelector(
      '[data-slot="status-announcer"] [aria-live="polite"]',
    ) as HTMLElement;
    const assertive = document.querySelector(
      '[data-slot="status-announcer"] [aria-live="assertive"]',
    ) as HTMLElement;
    await act(async () => {
      screen.getByRole("button", { name: "announce Saved" }).click();
      await Promise.resolve();
    });
    expect(polite).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(ANNOUNCEMENT_CLEAR_MS + 1));
    expect(polite).toBeEmptyDOMElement();
    // The same message again is announced again.
    await act(async () => {
      screen.getByRole("button", { name: "announce Saved" }).click();
      await Promise.resolve();
    });
    expect(polite).toHaveTextContent("Saved");
    await act(async () => {
      screen.getByRole("button", { name: "announce Couldn't save" }).click();
      await Promise.resolve();
    });
    expect(assertive).toHaveTextContent("Couldn't save");
    act(() => vi.advanceTimersByTime(ANNOUNCEMENT_CLEAR_MS + 1));
    expect(polite).toBeEmptyDOMElement();
    expect(assertive).toBeEmptyDOMElement();
  });
});

describe("InlineError", () => {
  it("is announced as an alert and guards its retry while pending", async () => {
    const user = userEvent.setup();
    let resolve: () => void = () => undefined;
    const onRetry = vi.fn(() => new Promise<void>((done) => (resolve = done)));
    render(
      <InlineError
        title="Couldn't load Now"
        description="Your tasks are safe. Check your connection and try again."
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load Now");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    const busy = screen.getByRole("button", { name: "Trying again…" });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("omits the retry button when there is nothing to retry", () => {
    render(<InlineError title="Not found" description="This task may have moved." />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("SaveStatus", () => {
  it("describes each state truthfully and offers Retry after a failure", async () => {
    const user = userEvent.setup();
    const at = new Date(2026, 8, 15, 9, 41);
    expect(saveStatusText({ kind: "saved", at }, "en-GB")).toBe("Saved 09:41");
    expect(saveStatusText({ kind: "unsaved" })).toBe("Unsaved changes");
    expect(saveStatusText({ kind: "saving" })).toBe("Saving…");
    const onRetry = vi.fn();
    const { rerender } = render(<SaveStatus state={{ kind: "saving" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    expect(document.querySelector('[data-slot="spinner"]')).toHaveAttribute("aria-hidden", "true");
    rerender(<SaveStatus state={{ kind: "failed", onRetry }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't save — draft kept");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("loading and empty states", () => {
  it("marks skeleton regions busy with an accessible label and hides the bars", () => {
    render(<SkeletonLines label="Loading tasks" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading tasks");
    expect(status.querySelectorAll('[data-slot="skeleton"][aria-hidden="true"]')).toHaveLength(3);
    const { container } = render(<Skeleton className="h-3" />);
    expect(container.firstElementChild).toHaveClass("sym-skeleton");
  });

  it("renders a titled empty state with an optional heading, action and decorative art", () => {
    render(
      <EmptyState
        title="Nothing here yet"
        description="Add a task above and press Enter."
        headingLevel={2}
        illustration={<ThemeIllustration />}
        action={<button type="button">Add task</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Nothing here yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(document.querySelector(".sym-empty-art")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelectorAll(".sym-empty-art > svg")).toHaveLength(6);
    const { container } = render(<PageIllustration />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("labels a spinner only when asked", () => {
    render(<Spinner label="Adding" />);
    expect(screen.getByRole("img", { name: "Adding" })).toBeInTheDocument();
  });
});
