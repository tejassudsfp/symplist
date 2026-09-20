import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsFrame } from "@/features/access/settings/settings-frame";
import { AboutScreen, MIT_LICENSE_TEXT, shortBuildId } from "./about-screen.tsx";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/about" }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function renderAbout(buildSha = "0123456789abcdef") {
  return render(
    <SettingsFrame>
      <AboutScreen buildSha={buildSha} />
    </SettingsFrame>,
  );
}

describe("Settings → About", () => {
  it("shows the product identity and unobtrusive author attribution", () => {
    renderAbout();

    expect(screen.getByText("symplist")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "About Symplist" })).toBeInTheDocument();
    expect(screen.getByText("“The most productive thing is often the most simple.”")).toBeVisible();
    expect(screen.getByText(/every task has a page and a conversation with Simon/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Tejas Parthasarathi Sudarshan/ })).toHaveAttribute(
      "href",
      "https://tejassuds.com",
    );

    const navigation = screen.getByRole("navigation", { name: "Settings" });
    expect(within(navigation).getByRole("link", { name: "About" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(navigation).getByRole("link", { name: "← Back to workspace" })).toHaveAttribute(
      "href",
      "/now",
    );
  });

  it("links to the established repository, self-hosting material and keyboard help", () => {
    renderAbout();

    expect(screen.getByRole("link", { name: /Source repository/ })).toHaveAttribute(
      "href",
      "https://github.com/tejassudsfp/symplist",
    );
    expect(screen.getByRole("link", { name: /Self-hosting/ })).toHaveAttribute(
      "href",
      "https://github.com/tejassudsfp/symplist/blob/main/SELF_HOSTING.md",
    );
    for (const link of [
      screen.getByRole("link", { name: /Source repository/ }),
      screen.getByRole("link", { name: /Self-hosting/ }),
      screen.getByRole("link", { name: /Project documentation/ }),
    ]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByRole("link", { name: "Keyboard settings" })).toHaveAttribute(
      "href",
      "/settings/shortcuts",
    );
    expect(screen.getByText(/Self-hosting never requires a paid Symplist license/)).toBeVisible();
    expect(screen.getByText(/services you choose may still have their own costs/)).toBeVisible();
  });

  it("shows the exact shipped MIT text in a keyboard-scrollable dialog and restores focus", async () => {
    const user = userEvent.setup();
    renderAbout();
    const trigger = screen.getByRole("button", { name: "View license" });

    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "MIT License" });
    const license = within(dialog).getByRole("textbox", { name: "MIT License text" });
    await waitFor(() => expect(license).toHaveFocus());
    expect((license as HTMLTextAreaElement).value).toContain(
      "Copyright (c) 2026 Tejas Parthasarathi Sudarshan",
    );
    expect((license as HTMLTextAreaElement).value).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(license).toHaveAttribute("readonly");
    expect(license).toHaveClass("overflow-y-auto");

    await user.click(within(dialog).getByRole("button", { name: "Close license" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "MIT License" })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("keeps the embedded license identical to the repository license", () => {
    const path = resolve(process.cwd(), "../../LICENSE");
    expect(MIT_LICENSE_TEXT).toBe(readFileSync(path, "utf8").trim());
  });

  it("shows quiet validated build information and a safe local fallback", () => {
    const { rerender } = render(<AboutScreen buildSha="ABCDEF0123456789" />);
    expect(screen.getByText("abcdef012345")).toBeVisible();

    rerender(<AboutScreen buildSha={'<script data-private="value">'} />);
    expect(screen.getByText("Local development")).toBeVisible();
    expect(screen.queryByText(/data-private/)).toBeNull();
    expect(shortBuildId(" 0123456 ")).toBe("0123456");
    expect(shortBuildId("not-a-commit")).toBeNull();
  });

  it("uses one-column mobile resources that become two columns and bounds the modal to the viewport", async () => {
    const user = userEvent.setup();
    const { container } = renderAbout();
    expect(container.querySelector('[data-slot="about-resources"]')).toHaveClass(
      "grid-cols-1",
      "sm:grid-cols-2",
    );

    await user.click(screen.getByRole("button", { name: "View license" }));
    expect(await screen.findByRole("dialog", { name: "MIT License" })).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "w-[calc(100vw-2rem)]",
    );
  });
});
