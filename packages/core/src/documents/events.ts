import type { DocumentAuthorKind } from "@symplist/docs";

/** The internal event type the worker sends when `document-git` published a revision (§6.2, §7). */
export const DOCUMENT_HEAD_CHANGED_EVENT = "document.head_changed";

/** A committed publication, announced as `document.head_changed` on the owner's `user` topic (§7). */
export interface DocumentHeadChanged {
  readonly ownerId: string;
  readonly taskId: string;
  readonly revision: string;
  readonly generation: number;
  readonly author: DocumentAuthorKind;
  readonly changedSectionIds: readonly string[];
}

/**
 * Where publications are announced: the api publishes on the realtime hub directly; the worker signs
 * an internal event whose payload carries only ids, enums and counts (§6.2, §8.3).
 */
export interface DocumentEventSink {
  headChanged(event: DocumentHeadChanged): Promise<void>;
  /** Receives announcement failures by stable code; never rethrown. */
  onError?(error: unknown): void;
}

/** The ids-only internal event payload for a head change. */
export function headChangedPayload(event: DocumentHeadChanged): {
  readonly taskId: string;
  readonly revision: string;
  readonly generation: number;
  readonly author: DocumentAuthorKind;
  readonly changedSectionIds: readonly string[];
} {
  return {
    taskId: event.taskId,
    revision: event.revision,
    generation: event.generation,
    author: event.author,
    changedSectionIds: event.changedSectionIds.slice(0, 100),
  };
}
