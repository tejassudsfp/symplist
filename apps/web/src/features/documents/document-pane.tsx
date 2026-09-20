"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalActions } from "@/actions/provider";
import { SafeMarkdown } from "@/components/markdown/safe-markdown";
import { Button } from "@/components/ui/button";
import { EmptyState, PageIllustration } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { type SaveState, SaveStatus } from "@/components/ui/save-status";
import { SkeletonLines } from "@/components/ui/skeleton";
import { useAnnouncer } from "@/components/ui/status-announcer";
import type { DocumentApi } from "./api.ts";
import { ConflictReview } from "./conflict-review.tsx";
import { clearActiveDocument, type DocumentController, setActiveDocument } from "./controller.ts";
import type { EditorHandle } from "./editor.ts";
import { FindBar } from "./find-bar.tsx";
import { HistoryIcon } from "./icons.tsx";
import { isSessionFailure } from "./messages.ts";
import { outlineRequestHandler } from "./outline-request.ts";
import type { ToolbarCommand } from "./page-commands.ts";
import { PageView, type PageViewHandle } from "./page-view.tsx";
import { RawView } from "./raw-view.tsx";
import type { watchDocumentHead } from "./realtime.ts";
import { documentHistoryPath } from "./routes.ts";
import type { SchedulerTimers } from "./save-scheduler.ts";
import {
  offsetOfLine,
  positionOfOffset,
  sectionIndexOfHeading,
  type ViewPosition,
} from "./sections.ts";
import { DocumentToolbar } from "./toolbar.tsx";
import { type DocumentView, type ReadOnlyReason, useDocument } from "./use-document.ts";

/**
 * The selected task's page (§9.3, task_document.md): the Milkdown page view and the lossless
 * CodeMirror Markdown view over one buffer, a local unsaved buffer with throttled drafts, publishing
 * on idle, blur, task switch, Mod+S and at most once a minute, a truthful save status, agent updates
 * announced on the socket, and concurrent-edit conflict review that never implies an overwrite.
 */

export interface DocumentPaneProps {
  /** The selected task. The shell mounts a fresh pane for each task. */
  readonly taskId: string;
  /** Test and preview seam: the documents API to call. Defaults to the app-wide client. */
  readonly api?: DocumentApi;
  /** Test seam: the clock and timers behind the save schedule. */
  readonly timers?: SchedulerTimers;
  /** Test seam: the realtime subscription. */
  readonly watch?: typeof watchDocumentHead;
}

function readOnlyNotice(reason: ReadOnlyReason): { title: string; description: string } {
  switch (reason) {
    case "raw_html":
      return {
        title: "This page contains HTML",
        description:
          "The page view would drop it, so it is shown read-only. Switch to Markdown to edit every character.",
      };
    case "too_complex":
      return {
        title: "This page is too large for the page view",
        description: "It is shown read-only. Switch to Markdown to edit it.",
      };
    case "locked":
      return {
        title: "This page is read-only",
        description: "You can read it, but changes can't be saved right now.",
      };
  }
}

export function DocumentPane({ taskId, api, timers, watch }: DocumentPaneProps) {
  const [view, setView] = useState<DocumentView>("page");
  const [finding, setFinding] = useState(false);
  const { announce } = useAnnouncer();
  const actions = useOptionalActions();
  const pathname = usePathname();
  const doc = useDocument({
    taskId,
    view,
    ...(api ? { api } : {}),
    ...(timers ? { timers } : {}),
    ...(watch ? { watch } : {}),
  });
  const { state, setBuffer, flush } = doc;
  const pageRef = useRef<PageViewHandle | null>(null);
  const rawRef = useRef<EditorHandle | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const carried = useRef<ViewPosition | null>(null);
  const [active, setActive] = useState<readonly ToolbarCommand[]>([]);

  const pageEditable = state.readOnly === null;
  const rawEditable = state.readOnly !== "locked";
  const currentRef = view === "page" ? pageRef : rawRef;

  const switchView = useCallback(
    (next: DocumentView) => {
      if (next === view) return;
      const from = view === "page" ? pageRef.current : rawRef.current;
      carried.current = from?.position() ?? null;
      setFinding(false);
      setView(next);
    },
    [view],
  );

  // Restore the carried section once the incoming view has mounted (Milkdown starts asynchronously).
  useEffect(() => {
    const target = carried.current;
    if (!target) return;
    let attempts = 0;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      const editor = view === "page" ? pageRef.current : rawRef.current;
      const ready = view === "page" ? (pageRef.current?.ready() ?? false) : editor !== null;
      if (editor && ready) {
        carried.current = null;
        editor.setPosition(target, { focus: true });
        return;
      }
      attempts += 1;
      if (attempts > 40) {
        carried.current = null;
        return;
      }
      handle = setTimeout(apply, 25);
    };
    apply();
    return () => {
      if (handle) clearTimeout(handle);
    };
  }, [view]);

  // Publishing on blur means leaving the whole pane, not moving to the toolbar (§9.3). The listener
  // is native rather than a JSX handler so the wrapper stays a plain, non-interactive container.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && element.contains(next)) return;
      flush("blur");
    };
    element.addEventListener("focusout", onFocusOut);
    return () => element.removeEventListener("focusout", onFocusOut);
  }, [flush]);

  useEffect(() => {
    const onHidden = () => {
      if (globalThis.document?.visibilityState === "hidden") flush("blur");
    };
    globalThis.document?.addEventListener("visibilitychange", onHidden);
    return () => globalThis.document?.removeEventListener("visibilitychange", onHidden);
  }, [flush]);

  const openFind = useCallback(() => {
    setFinding(true);
    return true;
  }, []);

  // The action registry drives Mod+S and Mod+F through this handle (§10.2).
  useEffect(() => {
    const controller: DocumentController = {
      taskId,
      editable: view === "page" ? pageEditable : rawEditable,
      save: () => flush("shortcut"),
      find: () => openFind(),
    };
    setActiveDocument(controller);
    return () => clearActiveDocument(controller);
  }, [taskId, view, pageEditable, rawEditable, flush, openFind]);

  const saveState: SaveState | null = useMemo(() => {
    switch (state.save.kind) {
      case "idle":
        return null;
      case "saved":
        return { kind: "saved", at: new Date(state.save.at) };
      case "unsaved":
        return { kind: "unsaved" };
      case "saving":
        return { kind: "saving" };
      case "failed":
        return { kind: "failed", onRetry: () => flush("retry") };
    }
  }, [state.save, flush]);

  const revealUpdate = useCallback(() => {
    const update = state.agentUpdate;
    if (!update) return;
    const index =
      (update.heading ? sectionIndexOfHeading(state.buffer, update.heading) : null) ??
      (update.lineStart !== null
        ? positionOfOffset(state.buffer, offsetOfLine(state.buffer, update.lineStart)).sectionIndex
        : 0);
    currentRef.current?.setPosition({ sectionIndex: index, offsetInSection: 0 }, { focus: true });
    doc.dismissAgentUpdate();
    announce(`Moved to ${update.heading ?? "the updated section"}`);
  }, [state.agentUpdate, state.buffer, currentRef, doc, announce]);

  const askForOutline = useCallback(() => {
    if (actions) {
      void actions.invoke("documents.ask_outline", "pointer", "page");
      return;
    }
    const handler = outlineRequestHandler();
    if (!handler) {
      announce("Simon isn't available yet");
      return;
    }
    void handler(taskId);
  }, [actions, announce, taskId]);

  const failure = state.failure;
  const empty = state.buffer.trim().length === 0;

  return (
    <div className="sym-doc" data-slot="document-pane" data-view={view} ref={container}>
      <h1 className="sr-only">Task page</h1>

      <div className="sym-doc-meta">
        {saveState ? <SaveStatus state={saveState} /> : null}
        {state.agentUpdate ? (
          <button
            type="button"
            className="sym-doc-pill"
            data-slot="agent-update"
            onClick={revealUpdate}
          >
            {state.agentUpdate.label}
            <span aria-hidden="true">↓</span>
          </button>
        ) : null}
        <span className="sym-doc-meta-spacer" />
        <fieldset className="sym-doc-views">
          <legend className="sr-only">View</legend>
          <button
            type="button"
            className="sym-doc-view-button"
            aria-pressed={view === "page"}
            onClick={() => switchView("page")}
          >
            Page
          </button>
          <button
            type="button"
            className="sym-doc-view-button font-mono"
            aria-pressed={view === "raw"}
            onClick={() => switchView("raw")}
          >
            Markdown
          </button>
        </fieldset>
        <Link
          className="sym-doc-history-link"
          href={documentHistoryPath(taskId, pathname)}
          aria-label="Document history"
          title="History"
        >
          <HistoryIcon />
        </Link>
      </div>

      {state.phase === "loading" ? <SkeletonLines label="Loading this page" /> : null}

      {state.phase === "failed" && failure ? (
        <InlineError
          title={failure.title}
          description={failure.description}
          onRetry={failure.retryable ? () => doc.reload() : undefined}
          retryLabel="Try again"
        />
      ) : null}

      {state.phase === "failed" && failure && isSessionFailure(failure.code) ? (
        <p className="sym-doc-notice">
          <a className="sym-doc-link" href="/signin">
            Sign in again
          </a>
        </p>
      ) : null}

      {state.phase === "ready" && state.conflict ? (
        <ConflictReview
          taskId={taskId}
          api={doc.api}
          conflict={state.conflict}
          draftMarkdown={state.buffer}
          onApply={doc.resolveConflict}
          onKeepDraft={doc.keepDraft}
          onDiscardDraft={doc.discardDraft}
        />
      ) : null}

      {/* A locked page says so in either view: the Markdown editor is refused too, and an editor
          that silently ignores typing explains nothing (system_states.md). */}
      {state.phase === "ready" && state.readOnly && (view === "page" || !rawEditable) ? (
        <div className="sym-doc-notice" role="status" data-slot="read-only-notice">
          <p className="sym-doc-notice-title">{readOnlyNotice(state.readOnly).title}</p>
          <p>{readOnlyNotice(state.readOnly).description}</p>
          {state.readOnly === "locked" ? null : (
            <Button variant="secondary" size="sm" onClick={() => switchView("raw")}>
              Switch to Markdown
            </Button>
          )}
        </div>
      ) : null}

      {state.phase === "ready" && finding ? (
        <FindBar
          editor={currentRef}
          revision={`${view}:${state.buffer.length}`}
          onClose={() => {
            setFinding(false);
            currentRef.current?.focus();
          }}
        />
      ) : null}

      {state.phase === "ready" ? (
        view === "page" ? (
          pageEditable ? (
            empty ? (
              <EmptyState
                illustration={<PageIllustration />}
                title="Nothing on this page yet"
                description="Start writing, or ask Simon to draft a first section."
                action={
                  <>
                    <Button variant="secondary" size="sm" onClick={() => switchView("raw")}>
                      Write in Markdown
                    </Button>
                    <Button variant="secondary" size="sm" onClick={askForOutline}>
                      Ask Simon for an outline
                    </Button>
                  </>
                }
              />
            ) : (
              <>
                <DocumentToolbar
                  active={active}
                  onCommand={(command) => {
                    pageRef.current?.command(command);
                    setActive(pageRef.current?.activeCommands() ?? []);
                  }}
                />
                <PageView
                  ref={pageRef}
                  value={state.buffer}
                  onChange={setBuffer}
                  onSelectionChange={() => setActive(pageRef.current?.activeCommands() ?? [])}
                />
              </>
            )
          ) : (
            <div className="sym-markdown sym-doc-preview" data-slot="page-preview">
              <SafeMarkdown source={state.buffer} headingLevelStart={2} />
            </div>
          )
        ) : (
          <RawView ref={rawRef} value={state.buffer} onChange={setBuffer} readOnly={!rawEditable} />
        )
      ) : null}
    </div>
  );
}
