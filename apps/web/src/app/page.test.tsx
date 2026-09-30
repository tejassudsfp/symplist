import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

/**
 * The root is the public homepage now, not a redirect into the workspace. A stranger has to be able
 * to learn what this is, get to the source, and reach the three legal pages — without signing in.
 */
describe("the public homepage", () => {
  it("states what Symplist is and offers the way in", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /most productive thing/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Open Symplist" })[0]).toHaveAttribute(
      "href",
      "/now",
    );
  });

  it("links the source and every legal page from the footer", () => {
    render(<HomePage />);
    const footer = screen.getByRole("contentinfo");
    for (const [name, href] of [
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
      ["Cookies", "/cookies"],
    ] as const) {
      expect(within(footer).getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(within(footer).getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://github.com/tejassudsfp/symplist",
    );
  });

  it("does not overclaim the encryption", () => {
    render(<HomePage />);
    // The service holds the keys. Saying otherwise on a public page would be a lie with legal weight.
    expect(screen.getByText(/It is not end-to-end encryption\./)).toBeInTheDocument();
    expect(screen.getByText(/Your email address is not/)).toBeInTheDocument();
  });

  it("says it is free and open, with no beta and no gate to get past", () => {
    render(<HomePage />);
    expect(screen.getByText(/there is no plan above it/i)).toBeInTheDocument();
    // The page may say "no invite" — what it must never do is ask for one.
    expect(screen.getByText(/No invite, no waitlist, no card/i)).toBeInTheDocument();
    expect(screen.queryByText(/beta/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/request an invite|join the waitlist/i)).not.toBeInTheDocument();
  });
});
