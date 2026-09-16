"use client";

import type {
  DocumentAuthor,
  DocumentHeadChangedEvent,
  DocumentHeadResponse,
  DocumentSectionSummary,
} from "@symplist/contracts";
import {
  canonicalizeMarkdown,
  isCanonicalMarkdown,
  MarkdownTooComplexError,
} from "@symplist/docs/markdown";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { IdempotencyKeys, isApiError } from "@/lib/api";
import { type DocumentApi, documentApi } from "./api.ts";
import { type DocumentFailure, describeFailure } from "./messages.ts";
import { watchDocumentHead } from "./realtime.ts";
import {
  browserSchedulerTimers,
  SaveScheduler,
  type SaveTrigger,
  type SchedulerTimers,
} from "./save-scheduler.ts";

/**
 * The task page's state machine (§9.3): the published head, the local unsaved buffer, throttled
 * drafts, the publish schedule, truthful save status, the formatting-normalization commit, agent
 * updates announced on the socket and concurrent-edit conflicts.
 *
 * Every rule that matters is data in this module rather than behaviour hidden in a component, so the
 * component tests drive it through a fake API and a fake clock.
 */

export type DocumentView = "page" | "raw";

/** Why the page view cannot be edited. */
export type ReadOnlyReason =
  /** The document contains raw HTML, which the page view would drop (§9.3). */
  | "raw_html"
  /** The document is past the parser work limits, so it is never re-serialized (§9.1). */
  | "too_complex"
  /** The server refuses writes for this caller or task. */
  | "locked";

export interface HeadSnapshot {
  readonly revision: string | null;
  readonly generation: number;
  readonly markdown: string;
  readonly author: DocumentAuthor | null;
  readonly updatedAt: number | null;
  readonly canonical: boolean;
  readonly hasRawHtml: boolean;
  readonly parseMode: "parsed" | "fallback";
  readonly sections: readonly DocumentSectionSummary[];
}

export type SaveIndicator =
  | { readonly kind: "idle" }
  | { readonly kind: "saved"; readonly at: number }
  | { readonly kind: "unsaved" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly failure: DocumentFailure };

export interface AgentUpdate {
  readonly revision: string;
  readonly author: DocumentAuthor;
  readonly sectionIds: readonly string[];
  /** For example "Updated Next steps"; falls back to the document when no section is named. */
  readonly label: string;
  /** The changed section's heading, used to find it again in the current buffer. */
  readonly heading: string | null;
  /** The first changed section's 1-based start line in the new head, for the raw view. */
  readonly lineStart: number | null;
  /** True when the update arrived while this device had unsaved changes. */
  readonly whileEditing: boolean;
}

export interface ConflictState {
  readonly currentRevision: string | null;
  readonly currentGeneration: number;
  readonly draftPreserved: boolean;
  /** The revision this device's draft started from. */
  readonly baseRevision: string | null;
}

export interface DocumentState {
  readonly phase: "loading" | "ready" | "failed";
  readonly failure: DocumentFailure | null;
  readonly head: HeadSnapshot | null;
  readonly buffer: string;
  readonly baseRevision: string | null;
  readonly dirty: boolean;
  readonly save: SaveIndicator;
  readonly conflict: ConflictState | null;
  readonly agentUpdate: AgentUpdate | null;
  readonly readOnly: ReadOnlyReason | null;
  /** Draft sequence of the newest draft this device wrote. */
  readonly draftSeq: number;
  /** True once a normalization commit is owed before the next page-view edit is published. */
  readonly normalizationPending: boolean;
}

type Action =
  | { readonly type: "loading" }
  | {
      readonly type: "loaded";
      readonly head: HeadSnapshot;
      readonly buffer: string;
      readonly baseRevision: string | null;
      readonly dirty: boolean;
      readonly conflict: ConflictState | null;
      readonly draftSeq: number;
      readonly normalizationPending: boolean;
      readonly readOnly: ReadOnlyReason | null;
    }
  | { readonly type: "load_failed"; readonly failure: DocumentFailure }
  | { readonly type: "buffer"; readonly markdown: string }
  | { readonly type: "draft_seq"; readonly seq: number }
  | { readonly type: "saving" }
  | {
      readonly type: "saved";
      readonly head: HeadSnapshot;
      readonly at: number;
      readonly stillDirty: boolean;
    }
  | { readonly type: "save_failed"; readonly failure: DocumentFailure }
  | {
      readonly type: "conflict";
      readonly conflict: ConflictState;
      readonly failure: DocumentFailure;
    }
  | { readonly type: "conflict_cleared" }
  | {
      readonly type: "head_changed";
      readonly head: HeadSnapshot;
      readonly update: AgentUpdate | null;
      readonly adopt: boolean;
    }
  | { readonly type: "agent_update_dismissed" }
  | {
      readonly type: "normalization_published";
      readonly revision: string;
      readonly head: HeadSnapshot;
    }
  | { readonly type: "read_only"; readonly reason: ReadOnlyReason | null };

const initialState: DocumentState = {
  phase: "loading",
  failure: null,
  head: null,
  buffer: "",
  baseRevision: null,
  dirty: false,
  save: { kind: "idle" },
  conflict: null,
  agentUpdate: null,
  readOnly: null,
  draftSeq: 0,
  normalizationPending: false,
};

export function documentReducer(state: DocumentState, action: Action): DocumentState {
  switch (action.type) {
    case "loading":
      return { ...state, phase: "loading", failure: null };
    case "loaded":
      return {
        ...state,
        phase: "ready",
        failure: null,
        head: action.head,
        buffer: action.buffer,
        baseRevision: action.baseRevision,
        dirty: action.dirty,
        conflict: action.conflict,
        draftSeq: action.draftSeq,
        normalizationPending: action.normalizationPending,
        readOnly: action.readOnly,
        save: action.dirty
          ? { kind: "unsaved" }
          : action.head.revision && action.head.updatedAt !== null
            ? { kind: "saved", at: action.head.updatedAt }
            : { kind: "idle" },
      };
    case "load_failed":
      return { ...state, phase: "failed", failure: action.failure };
    case "buffer":
      if (action.markdown === state.buffer) return state;
      return {
        ...state,
        buffer: action.markdown,
        dirty: true,
        save: { kind: "unsaved" },
      };
    case "draft_seq":
      return { ...state, draftSeq: action.seq };
    case "saving":
      return { ...state, save: { kind: "saving" } };
    case "saved":
      return {
        ...state,
        head: action.head,
        baseRevision: action.head.revision,
        dirty: action.stillDirty,
        conflict: null,
        normalizationPending: false,
        save: action.stillDirty ? { kind: "unsaved" } : { kind: "saved", at: action.at },
      };
    case "save_failed":
      return { ...state, save: { kind: "failed", failure: action.failure } };
    case "conflict":
      return {
        ...state,
        conflict: action.conflict,
        save: { kind: "failed", failure: action.failure },
      };
    case "conflict_cleared":
      return { ...state, conflict: null };
    case "head_changed":
      return action.adopt
        ? {
            ...state,
            head: action.head,
            buffer: action.head.markdown,
            baseRevision: action.head.revision,
            dirty: false,
            save:
              action.head.updatedAt === null
                ? { kind: "idle" }
                : { kind: "saved", at: action.head.updatedAt },
            agentUpdate: action.update ?? state.agentUpdate,
            normalizationPending: false,
            readOnly: action.head.hasRawHtml
              ? "raw_html"
              : action.head.parseMode === "fallback"
                ? "too_complex"
                : state.readOnly === "locked"
                  ? "locked"
                  : null,
          }
        : { ...state, head: action.head, agentUpdate: action.update ?? state.agentUpdate };
    case "agent_update_dismissed":
      return { ...state, agentUpdate: null };
    case "normalization_published":
      return {
        ...state,
        head: action.head,
        baseRevision: action.revision,
        normalizationPending: false,
      };
    case "read_only":
      return { ...state, readOnly: action.reason };
  }
}

function headFrom(response: DocumentHeadResponse): HeadSnapshot {
  return {
    revision: response.revision,
    generation: response.generation,
    markdown: response.markdown,
    author: response.author,
    updatedAt: response.updatedAt,
    canonical: response.canonical ?? isCanonical(response.markdown),
    hasRawHtml: response.hasRawHtml,
    parseMode: response.parseMode,
    sections: response.sections,
  };
}

function isCanonical(markdown: string): boolean {
  try {
    return isCanonicalMarkdown(markdown);
  } catch {
    return true;
  }
}

/** The canonical form of a document, or null when it is past the parser work limits (§9.1). */
export function canonicalOrNull(markdown: string): string | null {
  try {
    return canonicalizeMarkdown(markdown);
  } catch (error) {
    if (error instanceof MarkdownTooComplexError) return null;
    return null;
  }
}

function readOnlyFor(head: HeadSnapshot): ReadOnlyReason | null {
  if (head.hasRawHtml) return "raw_html";
  if (head.parseMode === "fallback") return "too_complex";
  return null;
}

/** "Updated Next steps" from the changed section ids of a head, or a document-level label. */
export function describeHeadChange(
  head: HeadSnapshot,
  sectionIds: readonly string[],
  author: DocumentAuthor,
): AgentUpdate {
  const named = sectionIds
    .map((id) => head.sections.find((section) => section.sectionId === id))
    .filter((section): section is DocumentSectionSummary => section !== undefined);
  const withHeading = named.find((section) => section.heading !== null);
  const who = author === "user" ? "Another device" : author === "mcp" ? "An agent" : "Simon";
  const label = withHeading?.heading
    ? `Updated ${withHeading.heading}`
    : `${who} updated this page`;
  return {
    revision: "",
    author,
    sectionIds,
    label,
    heading: withHeading?.heading ?? null,
    lineStart: (withHeading ?? named[0])?.lineStart ?? null,
    whileEditing: false,
  };
}

export interface UseDocumentOptions {
  readonly taskId: string;
  /** Defaults to the app-wide client; tests and previews pass a fake. */
  readonly api?: DocumentApi;
  readonly timers?: SchedulerTimers;
  /** Defaults to the shared realtime subscription. */
  readonly watch?: typeof watchDocumentHead;
  /** The current editor view, which decides whether a normalization commit is owed. */
  readonly view: DocumentView;
}

export interface DocumentHandle {
  readonly state: DocumentState;
  /** The API this page is bound to, so panels below it call the same one in tests and in the app. */
  readonly api: DocumentApi;
  /** The editor reports a new buffer. */
  setBuffer(markdown: string): void;
  /** Publishes now (Mod+S, blur, task switch, the Retry control). */
  flush(trigger: SaveTrigger): void;
  /** Reloads the head after a failure or a resync. */
  reload(): void;
  dismissAgentUpdate(): void;
  /** Publishes a reviewed merge on top of the current head and closes the conflict. */
  resolveConflict(markdown: string): Promise<void>;
  /** Closes the conflict banner and keeps editing; the draft stays. */
  keepDraft(): void;
  /** Explicitly drops this device's draft and shows the saved page. */
  discardDraft(): Promise<void>;
}

export function useDocument(options: UseDocumentOptions): DocumentHandle {
  const { taskId, view } = options;
  const [state, dispatch] = useReducer(documentReducer, initialState);
  const api = useMemo(() => options.api ?? documentApi(), [options.api]);
  const timers = options.timers ?? browserSchedulerTimers;
  const watch = options.watch ?? watchDocumentHead;

  const stateRef = useRef(state);
  stateRef.current = state;
  const viewRef = useRef(view);
  viewRef.current = view;
  const keysRef = useRef(new IdempotencyKeys());
  const savingRef = useRef(false);
  const queuedRef = useRef<SaveTrigger | null>(null);
  const inFlightRef = useRef<{
    key: string;
    markdown: string;
    base: string | null;
    kind: "edit" | "normalization";
    draftSeq: number | undefined;
  } | null>(null);
  const schedulerRef = useRef<SaveScheduler | null>(null);
  const mountedRef = useRef(true);
  const draftSeqRef = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      dispatch({ type: "loading" });
      try {
        const response = await api.head(taskId, signal);
        if (!mountedRef.current) return;
        const head = headFrom(response);
        const draft = response.draft;
        const hasDraft = draft !== null && draft.markdown !== head.markdown;
        const baseMatches = draft === null || draft.baseRevision === head.revision;
        const buffer = hasDraft ? draft.markdown : head.markdown;
        const conflict: ConflictState | null =
          hasDraft && (!baseMatches || draft.origin === "conflict")
            ? {
                currentRevision: head.revision,
                currentGeneration: head.generation,
                draftPreserved: true,
                baseRevision: draft.baseRevision,
              }
            : null;
        draftSeqRef.current = draft?.clientSeq ?? 0;
        dispatch({
          type: "loaded",
          head,
          buffer,
          baseRevision: draft && hasDraft ? draft.baseRevision : head.revision,
          dirty: hasDraft,
          conflict,
          draftSeq: draft?.clientSeq ?? 0,
          normalizationPending: !head.canonical && head.revision !== null,
          readOnly: readOnlyFor(head),
        });
      } catch (error) {
        if (!mountedRef.current) return;
        const failure = describeFailure(error);
        if (failure.code === "aborted") return;
        dispatch({ type: "load_failed", failure });
      }
    },
    [api, taskId],
  );

  const writeDraft = useCallback(async () => {
    const current = stateRef.current;
    if (!current.dirty || current.phase !== "ready") return;
    const seq = draftSeqRef.current + 1;
    draftSeqRef.current = seq;
    try {
      await api.putDraft(taskId, {
        baseRevision: current.baseRevision,
        clientSeq: seq,
        markdown: current.buffer,
      });
      if (mountedRef.current) dispatch({ type: "draft_seq", seq });
    } catch {
      // A draft is a convenience: the local buffer is still the source of truth on this device and
      // the next write carries the newest text.
    }
  }, [api, taskId]);

  const runSave = useCallback(
    async (trigger: SaveTrigger) => {
      const current = stateRef.current;
      if (current.phase !== "ready") return;
      if (savingRef.current) {
        queuedRef.current = trigger;
        return;
      }
      const retryPending = trigger === "retry" && inFlightRef.current !== null;
      if (!retryPending && !current.dirty && !current.normalizationPending) {
        if (current.save.kind === "failed")
          dispatch({
            type: "saved",
            head: current.head as HeadSnapshot,
            at: timers.now(),
            stillDirty: false,
          });
        return;
      }
      savingRef.current = true;
      dispatch({ type: "saving" });
      try {
        let base = current.baseRevision;
        let head = current.head;
        // The first page-view edit of a non-canonical document publishes the normalization on its
        // own, so the formatting change is one visible, content-neutral revision (decision R7).
        if (
          !retryPending &&
          viewRef.current === "page" &&
          current.normalizationPending &&
          head !== null &&
          head.revision !== null
        ) {
          const canonical = canonicalOrNull(head.markdown);
          if (canonical !== null && canonical !== head.markdown) {
            const normalized = await api.publish(taskId, {
              baseRevision: head.revision,
              markdown: canonical,
              kind: "normalization",
              idempotencyKey: keysRef.current.acquire("normalize"),
            });
            keysRef.current.release("normalize");
            if (normalized.revision) {
              base = normalized.revision;
              head = {
                ...head,
                revision: normalized.revision,
                markdown: canonical,
                canonical: true,
                generation: normalized.generation,
              };
              if (mountedRef.current) {
                dispatch({ type: "normalization_published", revision: normalized.revision, head });
              }
            }
          } else {
            dispatch({ type: "normalization_published", revision: head.revision, head });
          }
        }
        const payload = retryPending
          ? (inFlightRef.current as NonNullable<typeof inFlightRef.current>)
          : {
              key: keysRef.current.acquire("save"),
              markdown: stateRef.current.buffer,
              base,
              kind: "edit" as const,
              draftSeq: draftSeqRef.current > 0 ? draftSeqRef.current : undefined,
            };
        inFlightRef.current = payload;
        const result = await api.publish(taskId, {
          baseRevision: payload.base,
          markdown: payload.markdown,
          kind: payload.kind,
          ...(payload.draftSeq === undefined ? {} : { draftSeq: payload.draftSeq }),
          idempotencyKey: payload.key,
        });
        keysRef.current.release("save");
        inFlightRef.current = null;
        if (!mountedRef.current) return;
        const at = timers.now();
        const published = result.revision ?? stateRef.current.head?.revision ?? null;
        const nextHead: HeadSnapshot = {
          revision: published,
          generation: result.generation,
          markdown: payload.markdown,
          author: "user",
          updatedAt: at,
          canonical: true,
          hasRawHtml: stateRef.current.head?.hasRawHtml ?? false,
          parseMode: stateRef.current.head?.parseMode ?? "parsed",
          sections: stateRef.current.head?.sections ?? [],
        };
        const stillDirty = stateRef.current.buffer !== payload.markdown;
        dispatch({ type: "saved", head: nextHead, at, stillDirty });
        schedulerRef.current?.published();
        if (stillDirty) schedulerRef.current?.changed();
      } catch (error) {
        if (!mountedRef.current) return;
        const failure = describeFailure(error);
        if (isApiError(error, "document.conflict")) {
          keysRef.current.release("save");
          inFlightRef.current = null;
          const details = error.details as
            | { currentRevision?: unknown; currentGeneration?: unknown; draftPreserved?: unknown }
            | undefined;
          dispatch({
            type: "conflict",
            failure,
            conflict: {
              currentRevision:
                typeof details?.currentRevision === "string" ? details.currentRevision : null,
              currentGeneration:
                typeof details?.currentGeneration === "number" ? details.currentGeneration : 0,
              draftPreserved: details?.draftPreserved !== false,
              baseRevision: stateRef.current.baseRevision,
            },
          });
        } else {
          if (!failure.retryable) {
            keysRef.current.release("save");
            inFlightRef.current = null;
          }
          if (failure.code === "document.read_only" || failure.code === "task.archived") {
            dispatch({ type: "read_only", reason: "locked" });
          }
          dispatch({ type: "save_failed", failure });
        }
      } finally {
        savingRef.current = false;
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued && mountedRef.current && stateRef.current.dirty) {
          void runSave(queued);
        }
      }
    },
    [api, taskId, timers],
  );

  // One scheduler per mounted task page.
  useEffect(() => {
    const scheduler = new SaveScheduler({
      timers,
      onSave: (trigger) => {
        void runSave(trigger);
      },
      onDraft: () => {
        void writeDraft();
      },
    });
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [runSave, writeDraft, timers]);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [load]);

  // Task switch and unmount: publish whatever is pending and keep the draft (§9.3).
  useEffect(
    () => () => {
      const current = stateRef.current;
      if (current.dirty && current.phase === "ready") {
        void writeDraft();
        void runSave("task_switch");
      }
    },
    [runSave, writeDraft],
  );

  const refreshHead = useCallback(
    async (event: DocumentHeadChangedEvent | null) => {
      try {
        const response = await api.head(taskId);
        if (!mountedRef.current) return;
        const head = headFrom(response);
        const current = stateRef.current;
        if (head.revision === current.head?.revision && event === null) return;
        const update =
          event === null
            ? null
            : {
                ...describeHeadChange(head, event.changedSectionIds, event.author),
                revision: event.revision,
                whileEditing: current.dirty,
              };
        dispatch({ type: "head_changed", head, update, adopt: !current.dirty });
      } catch {
        // Leave the page as it is; the next save reports the conflict truthfully.
      }
    },
    [api, taskId],
  );

  useEffect(() => {
    return watch(taskId, {
      onHeadChanged: (event) => {
        const current = stateRef.current;
        // Our own publications are already applied.
        if (event.revision === current.head?.revision) return;
        void refreshHead(event);
      },
      onSnapshotHead: (_taskId, revision) => {
        const current = stateRef.current;
        if (current.phase !== "ready") return;
        if (revision === current.head?.revision) return;
        void refreshHead(null);
      },
      onResync: () => {
        if (!stateRef.current.dirty) void refreshHead(null);
      },
    });
  }, [taskId, watch, refreshHead]);

  const setBuffer = useCallback((markdown: string) => {
    const current = stateRef.current;
    if (current.phase !== "ready" || markdown === current.buffer) return;
    // A fresh edit after a failed attempt starts a new intent unless the failed payload is resent.
    if (current.save.kind === "failed" && inFlightRef.current === null) {
      keysRef.current.release("save");
    }
    dispatch({ type: "buffer", markdown });
    schedulerRef.current?.changed();
  }, []);

  const flush = useCallback(
    (trigger: SaveTrigger) => {
      const current = stateRef.current;
      if (current.phase !== "ready") return;
      if (trigger === "retry") {
        void runSave("retry");
        return;
      }
      if (
        !schedulerRef.current?.flush(trigger) &&
        (current.dirty || current.normalizationPending)
      ) {
        void runSave(trigger);
      }
    },
    [runSave],
  );

  const resolveConflict = useCallback(
    async (markdown: string) => {
      const current = stateRef.current;
      const base = current.conflict?.currentRevision ?? current.head?.revision ?? null;
      keysRef.current.release("save");
      inFlightRef.current = null;
      dispatch({ type: "buffer", markdown });
      dispatch({ type: "conflict_cleared" });
      dispatch({ type: "saving" });
      savingRef.current = true;
      try {
        const result = await api.publish(taskId, {
          baseRevision: base,
          markdown,
          kind: "edit",
          ...(draftSeqRef.current > 0 ? { draftSeq: draftSeqRef.current } : {}),
          idempotencyKey: keysRef.current.acquire("save"),
        });
        keysRef.current.release("save");
        if (!mountedRef.current) return;
        const at = timers.now();
        dispatch({
          type: "saved",
          at,
          stillDirty: false,
          head: {
            revision: result.revision,
            generation: result.generation,
            markdown,
            author: "user",
            updatedAt: at,
            canonical: true,
            hasRawHtml: current.head?.hasRawHtml ?? false,
            parseMode: current.head?.parseMode ?? "parsed",
            sections: current.head?.sections ?? [],
          },
        });
        schedulerRef.current?.published();
      } catch (error) {
        if (!mountedRef.current) return;
        const failure = describeFailure(error);
        keysRef.current.release("save");
        if (isApiError(error, "document.conflict")) {
          const details = error.details as
            | { currentRevision?: unknown; currentGeneration?: unknown }
            | undefined;
          dispatch({
            type: "conflict",
            failure,
            conflict: {
              currentRevision:
                typeof details?.currentRevision === "string" ? details.currentRevision : null,
              currentGeneration:
                typeof details?.currentGeneration === "number" ? details.currentGeneration : 0,
              draftPreserved: true,
              baseRevision: base,
            },
          });
        } else {
          dispatch({ type: "save_failed", failure });
        }
      } finally {
        savingRef.current = false;
      }
    },
    [api, taskId, timers],
  );

  const discardDraft = useCallback(async () => {
    try {
      await api.deleteDraft(taskId, draftSeqRef.current + 1);
    } catch {
      // The reload below shows whatever the server still holds.
    }
    draftSeqRef.current = 0;
    keysRef.current.release("save");
    inFlightRef.current = null;
    schedulerRef.current?.published();
    await load();
  }, [api, taskId, load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  const keepDraft = useCallback(() => {
    dispatch({ type: "conflict_cleared" });
  }, []);

  const dismissAgentUpdate = useCallback(() => {
    dispatch({ type: "agent_update_dismissed" });
  }, []);

  return useMemo(
    () => ({
      state,
      api,
      setBuffer,
      flush,
      reload,
      dismissAgentUpdate,
      resolveConflict,
      keepDraft,
      discardDraft,
    }),
    [
      state,
      api,
      setBuffer,
      flush,
      reload,
      dismissAgentUpdate,
      resolveConflict,
      keepDraft,
      discardDraft,
    ],
  );
}
