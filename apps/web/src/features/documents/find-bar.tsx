"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EditorHandle } from "./editor.ts";

/**
 * In-document find (note 13, Mod+F). It appears only while the editor is focused and in-app find is
 * available, so browser find still works everywhere else. Escape closes it and returns focus to the
 * document, as the shared dismissal rule requires.
 */
export interface FindBarProps {
  readonly editor: RefObject<EditorHandle | null>;
  readonly onClose: () => void;
  /** Re-runs the search when the document or the view changes underneath. */
  readonly revision: string;
}

export function FindBar({ editor, onClose, revision }: FindBarProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // `revision` is not read here: it names the document and view the matches were counted against, so
  // a change to either re-runs the search instead of leaving a stale count on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-running on `revision` is the point.
  useEffect(() => {
    if (query.length === 0) {
      setCount(0);
      editor.current?.clearMatch();
      return;
    }
    const total = editor.current?.showMatch(query, index) ?? 0;
    setCount(total);
  }, [query, index, revision, editor]);

  const step = (delta: number) => {
    if (count === 0) return;
    setIndex((current) => (((current + delta) % count) + count) % count);
  };

  return (
    <search className="sym-doc-find" data-slot="find-bar">
      <label className="sr-only" htmlFor={inputId}>
        Find in document
      </label>
      <input
        id={inputId}
        ref={input}
        type="search"
        className="sym-doc-find-input"
        placeholder="Find in document"
        value={query}
        onChange={(event) => {
          setIndex(0);
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            editor.current?.clearMatch();
            onClose();
          }
        }}
      />
      <span className="sym-doc-find-count" role="status" aria-live="polite">
        {query.length === 0
          ? "Type to search"
          : count === 0
            ? "No matches"
            : `${index + 1} of ${count}`}
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Previous match"
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        Previous
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Next match"
        disabled={count === 0}
        onClick={() => step(1)}
      >
        Next
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Close find"
        onClick={() => {
          editor.current?.clearMatch();
          onClose();
        }}
      >
        Close
      </Button>
    </search>
  );
}
