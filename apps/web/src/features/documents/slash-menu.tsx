"use client";

import { cn } from "cn";
import type { SlashCommand } from "./slash-commands.ts";

/**
 * The slash menu's list. Positioning and the open/closed decision belong to the page view; this
 * draws the options and keeps the highlighted one in sight.
 *
 * Focus never comes here. The caret has to stay in the document so typing keeps filtering, so the
 * editor keeps focus and points at the highlighted option with `aria-activedescendant`; the options
 * are buttons only so that a pointer can still choose one, and they are explicitly out of the tab
 * order. Keyboard selection is the editor's key handler, not a roving tabindex.
 */
export interface SlashMenuProps {
  readonly commands: readonly SlashCommand[];
  readonly selected: number;
  readonly onChoose: (command: SlashCommand) => void;
  readonly position: { readonly left: number; readonly top: number } | null;
  readonly listId: string;
}

export function slashOptionId(listId: string, id: string): string {
  return `${listId}-${id}`;
}

export function SlashMenu({ commands, selected, onChoose, position, listId }: SlashMenuProps) {
  if (commands.length === 0 || !position) return null;

  return (
    <div
      className="sym-doc-slash"
      data-slot="slash-menu"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      <div className="sym-doc-slash-list" role="listbox" id={listId} aria-label="Insert a block">
        {commands.map((command, index) => (
          <button
            type="button"
            key={command.id}
            id={slashOptionId(listId, command.id)}
            role="option"
            aria-selected={index === selected}
            // Out of the tab order: the document keeps focus while the menu is open.
            tabIndex={-1}
            ref={
              index === selected ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined
            }
            className={cn("sym-doc-slash-option", index === selected && "is-active")}
            // The caret must not leave the document, so the press must not move focus first.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(command)}
          >
            <span
              className={cn("sym-doc-slash-glyph", command.mono && "is-mono")}
              aria-hidden="true"
            >
              {command.glyph}
            </span>
            <span className="sym-doc-slash-text">
              <span className="sym-doc-slash-label">{command.label}</span>
              <span className="sym-doc-slash-hint">{command.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
