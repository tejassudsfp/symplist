"use client";

import { cn } from "cn";
import { type ToolbarCommand, toolbarButtons } from "./page-commands.ts";

/**
 * The page view's formatting toolbar (task_document.md). It is a real ARIA toolbar: one tab stop,
 * arrow keys between controls, and every control also reachable from the command palette through the
 * editor itself. Controls report their pressed state at the caret.
 */
export interface DocumentToolbarProps {
  readonly onCommand: (command: ToolbarCommand) => void;
  readonly active: readonly ToolbarCommand[];
  readonly disabled?: boolean;
}

export function DocumentToolbar({ onCommand, active, disabled = false }: DocumentToolbarProps) {
  const focusSibling = (index: number, delta: number, container: HTMLElement) => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    next?.focus();
  };
  return (
    <div role="toolbar" aria-label="Formatting" className="sym-doc-toolbar" data-slot="doc-toolbar">
      {toolbarButtons.map((button, index) => {
        const pressed = active.includes(button.id);
        return (
          <button
            key={button.id}
            type="button"
            className={cn("sym-doc-toolbar-button", button.mono && "font-mono")}
            style={{
              fontWeight: button.weight ?? 500,
              fontStyle: button.italic ? "italic" : "normal",
            }}
            aria-label={button.label}
            title={button.label}
            aria-pressed={pressed}
            disabled={disabled}
            tabIndex={index === 0 ? 0 : -1}
            onMouseDown={(event) => {
              // Keep the caret in the document: the command applies where the person was typing.
              event.preventDefault();
            }}
            onKeyDown={(event) => {
              const container = event.currentTarget.parentElement;
              if (!container) return;
              if (event.key === "ArrowRight") {
                event.preventDefault();
                focusSibling(index, 1, container);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                focusSibling(index, -1, container);
              }
            }}
            onClick={() => onCommand(button.id)}
          >
            <span aria-hidden="true">{button.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}
