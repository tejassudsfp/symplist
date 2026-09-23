import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { ApiError, ApiNetworkError } from "@/lib/api";
import { activeDocument } from "./controller.ts";
import { clearDocumentCache } from "./document-cache.ts";
import { DocumentPane } from "./document-pane.tsx";
import { FakeDocuments } from "./fake-api.ts";
import { installJsdomLayout } from "./jsdom-layout.ts";
import { setOutlineRequestHandler } from "./outline-request.ts";
import type { DocumentHeadListener, watchDocumentHead } from "./realtime.ts";
import { SAVE_IDLE_MS, type SchedulerTimers } from "./save-scheduler.ts";

const navigation = vi.hoisted(() => ({ pathname: "/now/01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";

const page = [
  "## Overview",
  "",
  "Three projects, one page.",
  "",
  "## Next steps",
  "",
  "* Pick three projects",
  "",
].join("\n");

class FakeTimers implements SchedulerTimers {
  time = 1_758_000_000_000;
  private next = 1;
  private readonly pending = new Map<number, { at: number; run: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { at: this.time + ms, run: callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.pending.delete(handle);
      this.time = timer.at;
      timer.run();
    }
    this.time = target;
  }
}

function fakeWatch() {
  const listeners = new Set<DocumentHeadListener>();
  const watch: typeof watchDocumentHead = (_taskId, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    watch,
    async headChanged(revision: string, author: "simon" | "user" | "mcp", sectionIds: string[]) {
      await act(async () => {
        for (const listener of listeners) {
          listener.onHeadChanged({
            taskId,
            revision,
            author,
            changedSectionIds: sectionIds,
          } as Parameters<DocumentHeadListener["onHeadChanged"]>[0]);
        }
        await Promise.resolve();
      });
    },
  };
}

let timers: FakeTimers;
let socket: ReturnType<typeof fakeWatch>;

function maybeSlot(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

/** The named region, once it is on screen. */
async function slot(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const element = maybeSlot(name);
    expect(element).not.toBeNull();
    return element as HTMLElement;
  });
}

function mount(fake: FakeDocuments) {
  return render(
    <StatusAnnouncerProvider>
      <DocumentPane taskId={fake.taskId} api={fake.api} timers={timers} watch={socket.watch} />
    </StatusAnnouncerProvider>,
  );
}

/**
 * Types into whichever editor is showing. jsdom keeps no caret inside a `contenteditable`, so every
 * synthetic keystroke lands at the start of the document; a single character keeps what reaches the
 * buffer unambiguous, which is all these cases need.
 */
async function type(user: ReturnType<typeof userEvent.setup>, character: string) {
  expect(character).toHaveLength(1);
  const editor = screen.getByRole("textbox");
  await user.click(editor);
  await user.type(editor, character);
}

beforeAll(() => {
  installJsdomLayout();
});

beforeEach(() => {
  timers = new FakeTimers();
  socket = fakeWatch();
  navigation.pathname = `/now/${taskId}`;
  clearDocumentCache();
});

afterEach(() => {
  setOutlineRequestHandler(null);
});

describe("loading and framing", () => {
  it("shows a loading state, then the page", async () => {
    mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    expect(screen.getByText("Loading this page")).toBeInTheDocument();
    await slot("page-view");
    expect(screen.queryByText("Loading this page")).toBeNull();
  });

  it("shows a task read before without blanking to a loading state again", async () => {
    // The complaint this cache exists for: every switch between tasks paid a fresh read, and the
    // api's D1 lane is 2 requests a second for the whole process, so the wait was a queue as much
    // as a round trip. A task already read renders from what was last seen and revalidates behind.
    const first = mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    await slot("page-view");
    first.unmount();

    mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    // The assertion that matters: the page is never blank on the way back.
    expect(screen.queryByText("Loading this page")).toBeNull();
    await slot("page-view");
    expect(screen.getByRole("textbox").textContent).toContain("Three projects, one page.");
  });

  it("offers Page and Markdown views and the history link", async () => {
    mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    await slot("page-view");
    expect(screen.getByRole("button", { name: "Page" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Markdown" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("link", { name: "Document history" })).toHaveAttribute(
      "href",
      `/tasks/${taskId}/history?from=${encodeURIComponent(`/now/${taskId}`)}`,
    );
  });

  it("switches to the Markdown view and back, keeping the content", async () => {
    const user = userEvent.setup();
    mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");
    expect(screen.getByRole("textbox").textContent).toContain("## Overview");
    await user.click(screen.getByRole("button", { name: "Page" }));
    await slot("page-view");
    expect(screen.getByRole("textbox").textContent).toContain("Three projects, one page.");
  });

  it("opens an empty page straight into the editor, not onto a screen to get past", async () => {
    mount(new FakeDocuments());
    // The editor itself, ready to take the caret: an empty page used to replace it with a card
    // whose only way forward was the raw Markdown view.
    expect(await slot("page-view")).toHaveAttribute("data-empty", "true");
  });

  it("keeps both starters available on an empty page without blocking it", async () => {
    mount(new FakeDocuments());
    await slot("page-starters");
    expect(screen.getByRole("button", { name: "Write in Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask Simon for an outline" })).toBeInTheDocument();
  });

  it("opens the Markdown view from the empty page", async () => {
    const user = userEvent.setup();
    mount(new FakeDocuments());
    await user.click(await screen.findByRole("button", { name: "Write in Markdown" }));
    await slot("raw-view");
  });

  it("asks Simon for an outline once a handler is registered", async () => {
    const handler = vi.fn();
    setOutlineRequestHandler(handler);
    const user = userEvent.setup();
    mount(new FakeDocuments());
    await user.click(await screen.findByRole("button", { name: "Ask Simon for an outline" }));
    expect(handler).toHaveBeenCalledWith(taskId);
  });

  it("says Simon is unavailable rather than pretending it started", async () => {
    const user = userEvent.setup();
    mount(new FakeDocuments());
    await user.click(await screen.findByRole("button", { name: "Ask Simon for an outline" }));
    await waitFor(() => expect(document.body.textContent).toContain("Simon isn't available yet"));
  });
});

describe("failures", () => {
  it("reports an unreachable page in plain language with a retry", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    fake.failNext = new ApiNetworkError();
    mount(fake);
    await slot("inline-error");
    const error = await slot("inline-error");
    expect(within(error).getByText(/You appear to be offline/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(error).getByRole("button", { name: "Try again" }));
    await slot("page-view");
  });

  it("offers the sign-in path when the session expired", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    fake.failNext = new ApiError({
      status: 401,
      code: "auth.required",
      message: "internal",
      requestId: "r",
    });
    mount(fake);
    expect(await screen.findByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/signin",
    );
    expect(document.body.textContent).not.toMatch(/401|Nest|D1/);
  });

  it("does not offer a retry for a failure that cannot succeed", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    fake.failNext = new ApiError({
      status: 404,
      code: "not_found",
      message: "internal",
      requestId: "r",
    });
    mount(fake);
    await slot("inline-error");
    expect(
      within(await slot("inline-error")).queryByRole("button", { name: "Try again" }),
    ).toBeNull();
  });
});

describe("read-only pages", () => {
  it("explains raw HTML and offers the Markdown view that can edit it", async () => {
    const user = userEvent.setup();
    mount(new FakeDocuments({ commits: [{ markdown: "Some text<br>and more\n" }] }));
    const notice = await slot("read-only-notice");
    expect(within(notice).getByText("This page contains HTML")).toBeInTheDocument();
    expect(maybeSlot("page-preview")).not.toBeNull();
    await user.click(within(notice).getByRole("button", { name: "Switch to Markdown" }));
    await slot("raw-view");
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true");
  });

  it("explains a page past the parser limits", async () => {
    mount(new FakeDocuments({ commits: [{ markdown: "a*b ".repeat(2_500) }] }));
    const notice = await slot("read-only-notice");
    expect(
      within(notice).getByText("This page is too large for the page view"),
    ).toBeInTheDocument();
  });

  it("offers no Markdown escape when the server refuses writes altogether", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");
    await type(user, "x");
    // Set after the keystroke: the first draft write would otherwise consume the queued failure.
    fake.failNext = new ApiError({
      status: 403,
      code: "document.read_only",
      message: "internal",
      requestId: "r",
    });
    await act(async () => {
      timers.advance(SAVE_IDLE_MS);
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false"),
    );
    // The Markdown view is refused too, so it says why rather than silently ignoring typing.
    const notice = await slot("read-only-notice");
    expect(within(notice).getByText("This page is read-only")).toBeInTheDocument();
    expect(within(notice).queryByRole("button", { name: "Switch to Markdown" })).toBeNull();
  });
});

describe("saving", () => {
  it("distinguishes typed from saved", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");

    await type(user, "A");
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeInTheDocument());

    await act(async () => {
      timers.advance(SAVE_IDLE_MS);
    });
    await waitFor(() => expect(screen.getByText(/^Saved /)).toBeInTheDocument());
    expect(fake.markdown).toContain("A");
    expect(fake.markdown).not.toBe(page);
  });

  it("keeps the draft and offers Retry when a save fails", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");

    await type(user, "T");
    fake.failNext = new ApiNetworkError();
    await act(async () => {
      timers.advance(SAVE_IDLE_MS);
    });
    await waitFor(() => expect(screen.getByText("Couldn't save — draft kept")).toBeInTheDocument());
    expect(screen.getByRole("textbox").textContent).toContain("T");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText(/^Saved /)).toBeInTheDocument());
    expect(fake.markdown).not.toBe(page);
  });

  it("publishes when focus leaves the whole pane", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    render(
      <StatusAnnouncerProvider>
        <DocumentPane taskId={fake.taskId} api={fake.api} timers={timers} watch={socket.watch} />
        <button type="button">Elsewhere</button>
      </StatusAnnouncerProvider>,
    );
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");
    await type(user, "B");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await waitFor(() => expect(fake.markdown).not.toBe(page));
  });

  it("registers a controller so Mod+S and Mod+F take the same path", async () => {
    mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    await waitFor(() => expect(activeDocument()).not.toBeNull());
    expect(activeDocument()?.taskId).toBe(taskId);
    expect(activeDocument()?.editable).toBe(true);
  });

  it("reports a read-only page through that controller", async () => {
    mount(new FakeDocuments({ commits: [{ markdown: "Text<br>more\n" }] }));
    await waitFor(() => expect(activeDocument()?.editable).toBe(false));
  });

  it("publishes through the controller, as Mod+S does", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");
    await type(user, "S");
    await act(async () => {
      activeDocument()?.save();
      await Promise.resolve();
    });
    await waitFor(() => expect(fake.markdown).not.toBe(page));
  });
});

describe("find in document", () => {
  it("opens through the controller and closes on Escape", async () => {
    const user = userEvent.setup();
    mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    await slot("page-view");
    act(() => {
      activeDocument()?.find();
    });
    const input = await screen.findByRole("searchbox", { name: "Find in document" });
    await user.type(input, "projects");
    await waitFor(() => expect(screen.getByText("1 of 2")).toBeInTheDocument());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  });

  it("closes when the view is switched, so its count is never stale", async () => {
    const user = userEvent.setup();
    mount(new FakeDocuments({ commits: [{ markdown: page }] }));
    await slot("page-view");
    act(() => {
      activeDocument()?.find();
    });
    await screen.findByRole("searchbox");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  });
});

describe("a revision published elsewhere", () => {
  it("shows a compact event that links to the change, without flashing the page", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");

    const commit = fake.publishElsewhere(page.replace("Pick three projects", "Pick four projects"));
    const sections = (await fake.api.head(taskId)).sections;
    const next = sections.find((section) => section.heading === "Next steps");
    await socket.headChanged(commit.revision, "simon", next ? [next.sectionId] : []);

    const pill = await slot("agent-update");
    expect(pill).toHaveTextContent("Updated Next steps");
    // The page itself is still there: the event never replaces the surface.
    expect(maybeSlot("page-view")).not.toBeNull();
  });

  it("moves to the changed section and dismisses the event", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");
    const commit = fake.publishElsewhere(page.replace("Pick three projects", "Pick four projects"));
    const sections = (await fake.api.head(taskId)).sections;
    const next = sections.find((section) => section.heading === "Next steps");
    await socket.headChanged(commit.revision, "simon", next ? [next.sectionId] : []);

    await user.click(await slot("agent-update"));
    await waitFor(() => expect(maybeSlot("agent-update")).toBeNull());
  });
});

describe("a concurrent edit conflict", () => {
  it("opens review rather than implying the local writing was overwritten", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");
    await type(user, "M");

    fake.publishElsewhere(`${page}\nSimon's.\n`);
    await act(async () => {
      timers.advance(SAVE_IDLE_MS);
    });

    const review = await slot("conflict-review");
    expect(
      within(review).getByRole("heading", { name: "This page changed while you were editing" }),
    ).toBeInTheDocument();
    expect(within(review).getByText(/Nothing you wrote was overwritten/)).toBeInTheDocument();
    expect(screen.getByRole("textbox").textContent).toContain("M");
  });

  it("publishes the reviewed result and closes the review", async () => {
    const user = userEvent.setup();
    const fake = new FakeDocuments({ commits: [{ markdown: page }] });
    mount(fake);
    await slot("page-view");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await slot("raw-view");
    await type(user, "M");
    fake.publishElsewhere(`${page}\nSimon's.\n`);
    await act(async () => {
      timers.advance(SAVE_IDLE_MS);
    });
    const review = await slot("conflict-review");
    await user.click(await within(review).findByRole("button", { name: "Apply and save" }));
    await waitFor(() => expect(maybeSlot("conflict-review")).toBeNull());
    await waitFor(() => expect(screen.getByText(/^Saved /)).toBeInTheDocument());
  });
});
