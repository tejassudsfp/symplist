import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HighlightedText, highlightSegments, SnippetText } from "./highlight.tsx";

describe("highlighting matched text", () => {
  it("marks the matched ranges and leaves the rest alone", () => {
    expect(highlightSegments("Refresh my portfolio", [{ start: 11, end: 20 }])).toEqual([
      { start: 0, text: "Refresh my ", match: false },
      { start: 11, text: "portfolio", match: true },
    ]);
  });

  it("orders, merges and clamps ranges so no character is ever lost", () => {
    const text = "Plan a quiet weekend";
    const segments = highlightSegments(text, [
      { start: 13, end: 40 },
      { start: 0, end: 4 },
      { start: 2, end: 6 },
      { start: 7, end: 7 },
      { start: -5, end: 1 },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
      "Plan a",
      "weekend",
    ]);
  });

  it("renders matches as marks and content that looks like markup as text (note 14)", () => {
    render(
      <HighlightedText
        text={'<img src=x onerror="alert(1)"> **bold**'}
        highlights={[{ start: 0, end: 4 }]}
      />,
    );
    const marks = screen.getAllByText("<img", { selector: "mark" });
    expect(marks).toHaveLength(1);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)"> **bold**');
  });

  it("shows ellipses only where the snippet window was cut", () => {
    const { rerender } = render(
      <SnippetText
        snippet={{
          text: "one framing sentence",
          highlights: [{ start: 4, end: 11 }],
          truncatedStart: true,
          truncatedEnd: true,
        }}
      />,
    );
    expect(document.body.textContent).toBe("…one framing sentence…");
    rerender(
      <SnippetText
        snippet={{
          text: "one framing sentence",
          highlights: [],
          truncatedStart: false,
          truncatedEnd: false,
        }}
      />,
    );
    expect(document.body.textContent).toBe("one framing sentence");
  });
});
