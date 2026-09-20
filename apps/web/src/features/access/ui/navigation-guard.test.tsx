import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  window.history.replaceState(null, "", "/settings/account");
  vi.spyOn(window.history, "back").mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
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
    // The guarded history entry is artificial, so replacing it has normal push semantics without
    // leaving a duplicate copy of the protected route in the Back stack.
    expect(navigation.replace).toHaveBeenCalledWith("/now");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("does not prompt again when the confirmed departure is a document navigation", async () => {
    const user = userEvent.setup();
    // The gate is an analytics-excluded group, so leaving it unloads the document (§15).
    render(<Harness href="/access/account" />);

    await user.click(screen.getByRole("link", { name: "Go" }));
    await user.click(await screen.findByRole("button", { name: "Leave anyway" }));

    expect(location.replace).toHaveBeenCalledWith("/access/account");
    expect(navigation.push).not.toHaveBeenCalled();
    // The page is still here until the browser unloads it; the confirmed leave must not be queried
    // a second time by the browser's own prompt.
    expect(wouldPrompt()).toBe(false);
  });

  it("restores and confirms a same-document browser Back before protected state can disappear", async () => {
    const user = userEvent.setup();
    const forward = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    render(<Harness href="/now" />);
    const sentinel = window.history.state;
    expect(sentinel).toEqual(
      expect.objectContaining({ __symplistNavigationGuard: expect.any(String) }),
    );

    // Back first reaches the real copy of this URL. The guard restores its same-URL sentinel before
    // opening a dialog, so Next never gets a chance to unmount a dirty draft or one-time key.
    fireEvent(window, new PopStateEvent("popstate", { state: null }));
    expect(forward).toHaveBeenCalledOnce();
    expect(screen.queryByText("Leave without saving?")).not.toBeInTheDocument();
    fireEvent(window, new PopStateEvent("popstate", { state: sentinel }));
    expect(await screen.findByText("Leave without saving?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(go).not.toHaveBeenCalled();

    fireEvent(window, new PopStateEvent("popstate", { state: null }));
    fireEvent(window, new PopStateEvent("popstate", { state: sentinel }));
    await user.click(await screen.findByRole("button", { name: "Leave anyway" }));
    expect(go).toHaveBeenCalledExactlyOnceWith(-2);
  });
});
