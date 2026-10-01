import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultApi } from "./api";
import {
  countdownLabel,
  panelMessage,
  shortcutLabel,
  type VaultPanelShell,
  VaultQuickAccess,
} from "./quick-access";

const session = vi.hoisted(() => ({
  current: { status: "signed_in", user: { email: "maya@example.com" } } as {
    status: string;
    user?: { email: string };
  },
}));

vi.mock("@/features/access/session", () => ({ useSession: () => session.current }));

const SECRET = "fictional-private-marker";
const id = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0001";
const noteId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e0002";
const secret = {
  id,
  version: 1,
  type: "secret" as const,
  title: "Personal API key",
  value: SECRET,
  updatedAt: new Date(2026, 8, 10, 12).getTime(),
};
const note = {
  id: noteId,
  version: 1,
  type: "note" as const,
  title: "Recovery notes",
  value: "Keep the printed sheet in the folder.",
  updatedAt: new Date(2026, 7, 30, 12).getTime(),
};

type Failure = Error & { code: string };
function apiFailure(code: string): Failure {
  return Object.assign(new Error(code), { code });
}

function fakeApi(overrides: Partial<VaultApi> = {}): VaultApi {
  const idle = Date.now() + 300_000;
  return {
    status: vi.fn(async () => ({
      state: "unlocked" as const,
      minimumKeyLength: 12,
      idleExpiresAt: idle,
    })),
    list: vi.fn(async () => ({
      items: [
        { ...secret, value: undefined },
        { ...note, value: undefined },
      ],
      nextCursor: null,
      idleExpiresAt: idle,
    })),
    read: vi.fn(async (wanted: string) => (wanted === noteId ? note : secret)),
    setup: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(async () => undefined),
    touch: vi.fn(async () => ({ idleExpiresAt: idle })),
    save: vi.fn(),
    remove: vi.fn(),
    sendCode: vi.fn(),
    verify: vi.fn(),
    reset: vi.fn(),
    grant: vi.fn(),
    ...overrides,
  } as unknown as VaultApi;
}

interface FakeShell extends VaultPanelShell {
  /** Fires the shell's "you were hidden" event, the way closing the popover does. */
  dismiss(): void;
  /** Fires the shell's "you were shown again" event. */
  reshow(): void;
}

function fakeShell(overrides: Partial<VaultPanelShell> = {}): FakeShell {
  const shown: Array<() => void> = [];
  const dismissed: Array<() => void> = [];
  return {
    close: vi.fn(),
    copy: vi.fn(async () => true),
    openApp: vi.fn(async () => true),
    report: vi.fn(),
    resize: vi.fn(),
    onShown: (listener: () => void) => {
      shown.push(listener);
      return () => shown.splice(shown.indexOf(listener), 1);
    },
    onDismissed: (listener: () => void) => {
      dismissed.push(listener);
      return () => dismissed.splice(dismissed.indexOf(listener), 1);
    },
    dismiss: () => {
      for (const listener of [...dismissed]) listener();
    },
    reshow: () => {
      for (const listener of [...shown]) listener();
    },
    ...overrides,
  };
}

const MAC_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";

beforeEach(() => {
  session.current = { status: "signed_in", user: { email: "maya@example.com" } };
  // jsdom reports its host platform, and the panel's visible keyboard hints follow it. The mockup is
  // a macOS menu-bar panel, so the tests assert its strings on a Mac agent rather than the runner's.
  Object.defineProperty(window.navigator, "userAgent", {
    value: MAC_AGENT,
    configurable: true,
  });
  // jsdom has no layout, so an element measures zero and the panel would never report a height. The
  // shell's own clamping is covered in apps/desktop; this makes the wiring observable.
  // A plain record, not a spread `DOMRect`: its members live on the prototype and a spread loses them.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 320,
    height: 312,
    top: 0,
    right: 320,
    bottom: 312,
    left: 0,
    toJSON: () => ({}),
  });
});

describe("the Vault quick-access panel, locked", () => {
  it("asks for the passphrase with the copy the panel was designed with", async () => {
    const api = fakeApi({
      status: vi.fn(async () => ({
        state: "locked" as const,
        minimumKeyLength: 12,
        idleExpiresAt: null,
      })),
    });
    render(<VaultQuickAccess api={api} shell={null} />);

    expect(
      await screen.findByRole("heading", { name: "Your vault is locked" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Enter your vault passphrase. It is separate from signing in."),
    ).toBeInTheDocument();
    expect(screen.getByText("Locks when this panel closes")).toBeInTheDocument();
    expect(screen.getByText("maya@example.com")).toBeInTheDocument();
    // A real form control with a real label, not a styled div with a placeholder.
    expect(screen.getByLabelText("Vault passphrase")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Unlock" })).toBeDisabled();
  });

  it("unlocks, then lists the items behind the passphrase", async () => {
    const api = fakeApi({
      status: vi
        .fn()
        .mockResolvedValueOnce({ state: "locked", minimumKeyLength: 12, idleExpiresAt: null })
        .mockResolvedValue({
          state: "unlocked",
          minimumKeyLength: 12,
          idleExpiresAt: Date.now() + 300_000,
        }),
    });
    const user = userEvent.setup();
    render(<VaultQuickAccess api={api} shell={null} />);

    await user.type(await screen.findByLabelText("Vault passphrase"), "a memorable phrase");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("Personal API key")).toBeInTheDocument();
    expect(api.unlock).toHaveBeenCalledWith("a memorable phrase", expect.any(String));
    expect(api.list).toHaveBeenCalledTimes(1);
    // The list is summaries: no plaintext arrives until an item is asked for.
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("says the passphrase did not match and keeps what was typed", async () => {
    const api = fakeApi({
      status: vi.fn(async () => ({
        state: "locked" as const,
        minimumKeyLength: 12,
        idleExpiresAt: null,
      })),
      unlock: vi.fn(async () => {
        throw apiFailure("vault.incorrect_key");
      }),
    });
    const user = userEvent.setup();
    render(<VaultQuickAccess api={api} shell={null} />);

    const field = await screen.findByLabelText("Vault passphrase");
    await user.type(field, "wrong one");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That passphrase didn’t match. Try again.",
    );
    expect(field).toHaveValue("wrong one");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
  });

  it("reports a lockout with the wait, not with a retry prompt", async () => {
    const api = fakeApi({
      status: vi.fn(async () => ({
        state: "locked" as const,
        minimumKeyLength: 12,
        idleExpiresAt: null,
      })),
      unlock: vi.fn(async () => {
        throw apiFailure("vault.throttled");
      }),
    });
    const user = userEvent.setup();
    render(<VaultQuickAccess api={api} shell={null} />);

    await user.type(await screen.findByLabelText("Vault passphrase"), "again");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait before trying again. Your items are unchanged.",
    );
  });
});

describe("the Vault quick-access panel, unlocked", () => {
  it("shows each item's kind and date, and the countdown to the idle lock", async () => {
    render(<VaultQuickAccess api={fakeApi()} shell={null} />);

    expect(await screen.findByText("Personal API key")).toBeInTheDocument();
    expect(screen.getByText(/^Secret ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Secure note ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Locks in \d:\d\d$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock now" })).toBeInTheDocument();
    expect(screen.getByText("↑↓ ↵ · ⌘L lock")).toBeInTheDocument();
  });

  it("opens an item with the value hidden until it is revealed", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<VaultQuickAccess api={api} shell={null} />);

    await user.click(await screen.findByText("Personal API key"));

    expect(await screen.findByLabelText("Hidden value")).toHaveTextContent("••••••••••••••••");
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.getByText("The clipboard clears in 30 seconds.")).toBeInTheDocument();
    expect(screen.getByText(/^Modified \S/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByLabelText("Revealed value")).toHaveTextContent(SECRET);
    expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true");
  });

  it("copies from the list without ever putting the value on screen", async () => {
    const api = fakeApi();
    const shell = fakeShell();
    render(<VaultQuickAccess api={api} shell={shell} />);
    await screen.findByText("Personal API key");

    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(shell.copy).toHaveBeenCalledWith(SECRET));
    expect(api.read).toHaveBeenCalledWith(id);
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Copied. The clipboard clears in 30 seconds.",
    );
  });

  it("moves the selection with the arrow keys and opens with ⌘↵", async () => {
    const api = fakeApi();
    render(<VaultQuickAccess api={api} shell={fakeShell()} />);
    await screen.findByText("Personal API key");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Recovery notes/ })).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(await screen.findByRole("heading", { name: "Recovery notes" })).toBeInTheDocument();
    expect(api.read).toHaveBeenLastCalledWith(noteId);
  });

  it("filters the list by title", async () => {
    const user = userEvent.setup();
    render(<VaultQuickAccess api={fakeApi()} shell={null} />);
    await screen.findByText("Personal API key");

    await user.type(screen.getByLabelText("Search vault"), "recovery");

    expect(screen.queryByText("Personal API key")).not.toBeInTheDocument();
    expect(screen.getByText("Recovery notes")).toBeInTheDocument();
  });

  it("locks on ⌘L and comes back asking for the passphrase", async () => {
    const api = fakeApi();
    render(<VaultQuickAccess api={api} shell={fakeShell()} />);
    await screen.findByText("Personal API key");

    fireEvent.keyDown(window, { key: "l", metaKey: true });

    expect(
      await screen.findByRole("heading", { name: "Your vault is locked" }),
    ).toBeInTheDocument();
    expect(api.lock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Personal API key")).not.toBeInTheDocument();
  });

  it("goes back to the list on escape, and closes the panel from the list", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    render(<VaultQuickAccess api={fakeApi()} shell={shell} />);

    await user.click(await screen.findByText("Personal API key"));
    await screen.findByRole("heading", { name: "Personal API key" });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByLabelText("Search vault")).toBeInTheDocument());
    expect(shell.close).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(shell.close).toHaveBeenCalledTimes(1);
  });

  it("says nothing is there rather than showing an empty list", async () => {
    const api = fakeApi({
      list: vi.fn(async () => ({
        items: [],
        nextCursor: null,
        idleExpiresAt: Date.now() + 300_000,
      })),
    });
    render(<VaultQuickAccess api={api} shell={null} />);

    expect(
      await screen.findByText(
        "Nothing in your vault yet. Add a secret or a secure note in Symplist.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("what the quick-access panel tells the shell", () => {
  it("reports the unlock it performed, so closing the panel locks it", async () => {
    const api = fakeApi({
      status: vi
        .fn()
        .mockResolvedValueOnce({ state: "locked", minimumKeyLength: 12, idleExpiresAt: null })
        .mockResolvedValue({
          state: "unlocked",
          minimumKeyLength: 12,
          idleExpiresAt: Date.now() + 300_000,
        }),
    });
    const shell = fakeShell();
    const user = userEvent.setup();
    render(<VaultQuickAccess api={api} shell={shell} />);

    await user.type(await screen.findByLabelText("Vault passphrase"), "a memorable phrase");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await screen.findByText("Personal API key");

    // Awaited, not asserted outright: the report is an effect, and a render that has already painted
    // the list has not necessarily flushed it. Asserting straight after the DOM made this pass locally
    // and fail on a loaded CI runner, which is a race in the test and not in the panel.
    await waitFor(() =>
      expect(shell.report).toHaveBeenCalledWith({
        unlocked: true,
        unlockedHere: true,
        email: "maya@example.com",
      }),
    );
  });

  it("does not claim an unlock it found already open, so the workspace keeps its vault", async () => {
    const shell = fakeShell();
    render(<VaultQuickAccess api={fakeApi()} shell={shell} />);
    await screen.findByText("Personal API key");

    await waitFor(() =>
      expect(shell.report).toHaveBeenCalledWith({
        unlocked: true,
        unlockedHere: false,
        email: "maya@example.com",
      }),
    );
    // Dismissal then locks nothing: the vault was not this panel's to close.
    shell.dismiss();
    expect(
      await screen.findByRole("heading", { name: "Your vault is locked" }),
    ).toBeInTheDocument();
  });

  it("forgets everything and locks what it opened when the panel is dismissed", async () => {
    const api = fakeApi({
      status: vi
        .fn()
        .mockResolvedValueOnce({ state: "locked", minimumKeyLength: 12, idleExpiresAt: null })
        .mockResolvedValue({
          state: "unlocked",
          minimumKeyLength: 12,
          idleExpiresAt: Date.now() + 300_000,
        }),
    });
    const shell = fakeShell();
    const user = userEvent.setup();
    render(<VaultQuickAccess api={api} shell={shell} />);

    await user.type(await screen.findByLabelText("Vault passphrase"), "a memorable phrase");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(await screen.findByText("Personal API key"));
    await user.click(await screen.findByRole("button", { name: "Reveal" }));
    expect(screen.getByLabelText("Revealed value")).toHaveTextContent(SECRET);

    shell.dismiss();

    expect(
      await screen.findByRole("heading", { name: "Your vault is locked" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(api.lock).toHaveBeenCalledTimes(1);
  });

  it("reads the vault again when the panel is shown a second time", async () => {
    const api = fakeApi();
    const shell = fakeShell();
    render(<VaultQuickAccess api={api} shell={shell} />);
    await screen.findByText("Personal API key");

    shell.reshow();

    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
  });

  it("asks the shell to size the window rather than filling the screen", async () => {
    const shell = fakeShell();
    render(<VaultQuickAccess api={fakeApi()} shell={shell} />);
    await screen.findByText("Personal API key");

    expect(shell.resize).toHaveBeenCalledWith(312);
  });

  it("links out through the shell instead of navigating itself", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    render(<VaultQuickAccess api={fakeApi()} shell={shell} />);
    await screen.findByText("Personal API key");

    await user.click(screen.getByRole("button", { name: "Open full vault ↗" }));
    expect(shell.openApp).toHaveBeenCalledWith("/vault");

    await user.click(screen.getByText("Personal API key"));
    await user.click(await screen.findByRole("button", { name: "Edit in Symplist ↗" }));
    expect(shell.openApp).toHaveBeenLastCalledWith(`/vault/items/${id}`);
  });
});

describe("the quick-access panel with nothing to unlock", () => {
  it("sends an unsigned-in Mac to the main window, and asks the api nothing", async () => {
    session.current = { status: "signed_out" };
    const api = fakeApi();
    const shell = fakeShell();
    render(<VaultQuickAccess api={api} shell={shell} />);

    expect(
      await screen.findByRole("heading", { name: "Sign in to use the vault here" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your session ended or this Mac hasn’t signed in yet. Sign in once in Symplist, then come back.",
      ),
    ).toBeInTheDocument();
    expect(api.status).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole("button", { name: "Open Symplist to sign in" }));
    expect(shell.openApp).toHaveBeenCalledWith("/signin");
  });

  it("sends someone with no vault yet to the full app to create one", async () => {
    const api = fakeApi({
      status: vi.fn(async () => ({
        state: "not_created" as const,
        minimumKeyLength: 12,
        idleExpiresAt: null,
      })),
    });
    const shell = fakeShell();
    render(<VaultQuickAccess api={api} shell={shell} />);

    expect(
      await screen.findByRole("heading", { name: "Set up your vault first" }),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open Symplist to set up" }));
    expect(shell.openApp).toHaveBeenCalledWith("/vault");
  });

  it("offers a retry when the api cannot be reached at all", async () => {
    const api = fakeApi({
      status: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({
          state: "unlocked",
          minimumKeyLength: 12,
          idleExpiresAt: Date.now() + 300_000,
        }),
    });
    const user = userEvent.setup();
    render(<VaultQuickAccess api={api} shell={null} />);

    expect(
      await screen.findByRole("heading", { name: "Couldn’t reach your vault" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Personal API key")).toBeInTheDocument();
  });

  it("shows the passphrase prompt when the api says the vault relocked mid-request", async () => {
    const api = fakeApi({
      list: vi.fn(async () => {
        throw apiFailure("vault.locked");
      }),
    });
    render(<VaultQuickAccess api={api} shell={null} />);

    expect(
      await screen.findByRole("heading", { name: "Your vault is locked" }),
    ).toBeInTheDocument();
  });
});

describe("the panel's small pure pieces", () => {
  it("counts down in minutes and seconds, and never below zero", () => {
    const at = Date.UTC(2026, 8, 10, 9, 41);
    expect(countdownLabel(at + 272_000, at)).toBe("4:32");
    expect(countdownLabel(at + 42_000, at)).toBe("0:42");
    expect(countdownLabel(at - 5_000, at)).toBe("0:00");
  });

  it("spells a shortcut the way the machine reading it does", () => {
    expect(shortcutLabel("F", MAC_AGENT)).toBe("⌘F");
    expect(shortcutLabel("L", "Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl+L");
  });

  it("says passphrase where the full vault screen says key, and defers otherwise", () => {
    expect(panelMessage(apiFailure("vault.incorrect_key"))).toBe(
      "That passphrase didn’t match. Try again.",
    );
    expect(panelMessage(apiFailure("vault.throttled"))).toBe(
      "Too many attempts. Wait before trying again. Your items are unchanged.",
    );
  });
});
