import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubNavigation } from "../test-support.tsx";
import { useNavigationGuard } from "./navigation-guard.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/settings/account",
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

const copy = {
  title: "Leave without saving?",
  description: "Your changes are not saved yet.",
  confirmLabel: "Leave anyway",
  cancelLabel: "Stay",
};

function Harness({ href }: { href: string }) {
  const guard = useNavigationGuard(true, copy);
  return (
    <div>
      <a href={href}>Go</a>
      {guard.dialog}
    </div>
  );
}

let location = stubNavigation("/settings/account");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/settings/account");
});

afterEach(() => {
  location.restore();
});

/** Whether a `beforeunload` raised now would show the browser's own prompt. */
function wouldPrompt(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("the navigation guard (settings_account.md, admin_invite_create.md)", () => {
  it("holds a link click for a decision and leaves once it is confirmed", async () => {
    const user = userEvent.setup();
    render(<Harness href="/now" />);
    expect(wouldPrompt()).toBe(true);

    await user.click(screen.getByRole("link", { name: "Go" }));
    expect(await screen.findByText("Leave without saving?")).toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(navigation.push).toHaveBeenCalledWith("/now");
  });

  it("does not prompt again when the confirmed departure is a document navigation", async () => {
    const user = userEvent.setup();
    // The gate is an analytics-excluded group, so leaving it unloads the document (§15).
    render(<Harness href="/access/account" />);

    await user.click(screen.getByRole("link", { name: "Go" }));
    await user.click(await screen.findByRole("button", { name: "Leave anyway" }));

    expect(location.assign).toHaveBeenCalledWith("/access/account");
    expect(navigation.push).not.toHaveBeenCalled();
    // The page is still here until the browser unloads it; the confirmed leave must not be queried
    // a second time by the browser's own prompt.
    expect(wouldPrompt()).toBe(false);
  });
});
