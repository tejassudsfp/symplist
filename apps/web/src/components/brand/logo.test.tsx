import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SymplistLogo, SymplistMark } from "./logo";

describe("the brand lockup", () => {
  it("names itself once: the wordmark is the name, so the group adds no image role", () => {
    const { container } = render(<SymplistLogo />);
    expect(screen.getByText("symplist")).toBeInTheDocument();
    expect(container.querySelector('[role="img"]')).toBeNull();
    // The mark is decoration beside readable text.
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("names itself when the wordmark is absent, so the mark alone is not silent", () => {
    render(<SymplistLogo withWordmark={false} />);
    expect(screen.getByRole("img", { name: "Symplist" })).toBeInTheDocument();
  });

  it("stays silent when a visible label already names it", () => {
    const { container } = render(<SymplistLogo withWordmark={false} label={null} />);
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it("carries no colour of its own, so it inherits every theme", () => {
    const { container } = render(<SymplistMark />);
    const svg = container.querySelector("svg");
    expect(svg?.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(svg?.querySelectorAll('[fill="currentColor"]')).toHaveLength(3);
    expect(svg?.querySelector("path")).toHaveAttribute("stroke", "currentColor");
  });

  it("keeps the geometry the brand is defined by", () => {
    const { container } = render(<SymplistMark />);
    const path = container.querySelector("path");
    // Line lengths step down by a constant 3.6: 20.1-9.1, 16.5-9.1, 12.9-9.1 = 11.0 / 7.4 / 3.8.
    expect(path).toHaveAttribute("d", "M9.1 6.5H20.1M9.1 12H16.5M9.1 17.5H12.9");
    expect(path).toHaveAttribute("stroke-width", "2.2");
    expect(path).toHaveAttribute("stroke-linecap", "round");
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 24 24");
  });

  it("stacks for narrow spaces", () => {
    const { container } = render(<SymplistLogo stacked />);
    expect(container.firstElementChild).toHaveClass("sym-logo--stacked");
  });
});
