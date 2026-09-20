import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type ToolbarCommand, toolbarButtons } from "./page-commands.ts";
import { DocumentToolbar } from "./toolbar.tsx";

function mount(props: Partial<Parameters<typeof DocumentToolbar>[0]> = {}) {
  const onCommand = vi.fn();
  render(<DocumentToolbar onCommand={onCommand} active={[]} {...props} />);
  return { onCommand };
}

describe("the formatting toolbar", () => {
  it("is a named toolbar with one control per command", () => {
    mount();
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    expect(toolbar).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(toolbarButtons.length);
    for (const button of toolbarButtons) {
      expect(screen.getByRole("button", { name: button.label })).toBeInTheDocument();
    }
  });

  it("stays small: the brief's quiet controls, not a ribbon", () => {
    expect(toolbarButtons.length).toBeLessThanOrEqual(8);
  });

  it("names every control for a screen reader, since the glyphs are decorative", () => {
    mount();
    for (const button of toolbarButtons) {
      const control = screen.getByRole("button", { name: button.label });
      expect(control).toHaveAttribute("title", button.label);
      expect(control.querySelector("span")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("runs the command a control stands for", async () => {
    const user = userEvent.setup();
    const { onCommand } = mount();
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    expect(onCommand).toHaveBeenCalledWith("bullet_list");
  });

  it("reports which commands are active at the caret", () => {
    const active: ToolbarCommand[] = ["bold", "heading"];
    mount({ active });
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Heading" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "false");
  });

  it("is one tab stop, with arrow keys between the controls", async () => {
    const user = userEvent.setup();
    mount();
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("tabindex", "0");
    for (const button of buttons.slice(1)) expect(button).toHaveAttribute("tabindex", "-1");

    buttons[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(buttons[0]).toHaveFocus();
  });

  it("wraps around at both ends", async () => {
    const user = userEvent.setup();
    mount();
    const buttons = screen.getAllByRole("button");
    buttons[0]?.focus();
    await user.keyboard("{ArrowLeft}");
    expect(buttons.at(-1)).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[0]).toHaveFocus();
  });

  it("keeps the caret in the document when a control is pressed", () => {
    mount();
    const button = screen.getByRole("button", { name: "Bold" });
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("disables every control while the page cannot be edited", async () => {
    const user = userEvent.setup();
    const { onCommand } = mount({ disabled: true });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(onCommand).not.toHaveBeenCalled();
  });
});
