import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import { setArtifactSurface } from "./artifact-surface.ts";
import { TaskArtifactsScreen } from "./artifacts-screen.tsx";
import { FakeDocuments } from "./fake-api.ts";

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
const now = 1_758_000_000_000;
const page = "## Overview\n\nThree projects, one page.\n";

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

function mount(fake: FakeDocuments, from?: string | null) {
  render(
    <TaskArtifactsScreen taskId={fake.taskId} from={from ?? null} api={fake.api} now={() => now} />,
  );
  return fake;
}

function saved(): FakeDocuments {
  return new FakeDocuments({
    taskId,
    now: () => now,
    commits: [{ markdown: page, committedAt: now - 5 * 60_000 }],
  });
}

afterEach(() => {
  setArtifactSurface(null);
});

describe("artifacts and links", () => {
  it("keeps the task's page one step away", () => {
    mount(saved(), `/later/${taskId}`);
    expect(screen.getByRole("link", { name: /Back to page/ })).toHaveAttribute(
      "href",
      `/later/${taskId}`,
    );
    expect(screen.getByRole("heading", { name: "Artifacts and links" })).toBeInTheDocument();
  });

  it("refuses an entry page that could navigate off site", () => {
    mount(saved(), "https://evil.example");
    expect(screen.getByRole("link", { name: /Back to page/ })).toHaveAttribute(
      "href",
      `/now/${taskId}`,
    );
  });

  it("links on to the page's revisions", () => {
    mount(saved(), `/now/${taskId}`);
    expect(screen.getByRole("link", { name: "See this page's revisions" })).toHaveAttribute(
      "href",
      `/tasks/${taskId}/history?from=${encodeURIComponent(`/now/${taskId}`)}`,
    );
  });

  it("shows a loading state, then the version a link would capture", async () => {
    mount(saved());
    expect(screen.getByText("Loading this page's version")).toBeInTheDocument();
    const version = await slot("source-version");
    expect(version.textContent).toContain("5 minutes ago");
    expect(version.textContent).toMatch(/Later edits never change a link that was already created/);
    expect(within(version).getByRole("time")).toHaveAttribute("title");
  });

  it("says a page with nothing saved has nothing to share yet", async () => {
    mount(new FakeDocuments({ taskId, now: () => now }));
    const notice = await slot("unsaved-source");
    expect(notice.textContent).toMatch(/has not been saved yet/);
    expect(maybeSlot("source-version")).toBeNull();
  });

  it("reports a failure in plain language and retries", async () => {
    const fake = saved();
    fake.failNext = new ApiNetworkError();
    mount(fake);
    const error = await slot("inline-error");
    expect(within(error).getByText(/You appear to be offline/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(error).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(maybeSlot("source-version")).not.toBeNull());
  });

  it("says there are no links, and creates nothing by being opened", async () => {
    const fake = saved();
    mount(fake);
    expect(await screen.findByText("No links yet")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been shared/)).toBeInTheDocument();
    expect(fake.calls.map((call) => call.name)).toEqual(["head"]);
  });

  it("never shows a token, a key or another task's document", async () => {
    mount(saved());
    await waitFor(() => expect(maybeSlot("source-version")).not.toBeNull());
    expect(document.body.textContent ?? "").not.toMatch(/token|secret|api[_ ]?key|password/i);
  });

  it("hands the list to the sharing feature once it registers one", async () => {
    const renderer = vi.fn((context: { taskId: string; headRevision: string | null }) => (
      <p data-slot="sharing-list">{`${context.taskId}:${context.headRevision}`}</p>
    ));
    setArtifactSurface(renderer);
    const fake = saved();
    mount(fake);
    await waitFor(() => expect(maybeSlot("sharing-list")).not.toBeNull());
    expect(maybeSlot("sharing-list")?.textContent).toBe(`${taskId}:${fake.head?.revision}`);
    expect(screen.queryByText("No links yet")).toBeNull();
  });

  it("keeps the technical revision as a secondary detail", async () => {
    mount(saved());
    expect(await screen.findByText(/This page is at revision [0-9a-f]{7}\./)).toBeInTheDocument();
  });
});
