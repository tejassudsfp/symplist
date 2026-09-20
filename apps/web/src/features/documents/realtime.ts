"use client";

import {
  type DocumentHeadChangedEvent,
  documentHeadChangedEventSchema,
  type TaskId,
  taskIdSchema,
  userTopicSnapshotSchema,
} from "@symplist/contracts";
import {
  RealtimeClient,
  type RealtimeStatus,
  realtimeUrl,
  type UserSubscription,
} from "@/lib/realtime";

/**
 * `document.head_changed` on the owner's `user` topic (§7, §9.2). The socket carries ids only, so a
 * head change is a signal to re-read the page, never content.
 *
 * One socket serves the whole app (§7). Until a feature owns an app-wide provider, this module keeps
 * the single client and lets tests (and later the integrator) supply their own with
 * {@link setDocumentRealtimeClient}.
 */

export interface DocumentHeadListener {
  /** A new revision was published for a task this listener has open. */
  onHeadChanged(event: DocumentHeadChangedEvent): void;
  /** The `user` snapshot named a head for the task; sent on every (re)subscription. */
  onSnapshotHead?(taskId: string, revision: string): void;
  /** The topic asked for a resync, or the socket reconnected: re-read the page. */
  onResync?(): void;
  onStatus?(status: RealtimeStatus): void;
}

let client: RealtimeClient | null = null;
let owned = false;

/** Replaces the shared client (tests, and the app-wide provider once one exists). */
export function setDocumentRealtimeClient(next: RealtimeClient | null): void {
  if (owned && client && client !== next) client.disconnect();
  client = next;
  owned = false;
}

function sharedClient(): RealtimeClient | null {
  if (client) return client;
  if (typeof window === "undefined") return null;
  const url = realtimeUrl();
  if (!url) return null;
  client = new RealtimeClient({ url });
  owned = true;
  return client;
}

const listeners = new Map<string, Set<DocumentHeadListener>>();
let subscription: UserSubscription | null = null;
let statusOff: (() => void) | null = null;

function openTaskIds(): TaskId[] {
  const ids: TaskId[] = [];
  for (const taskId of listeners.keys()) {
    const parsed = taskIdSchema.safeParse(taskId);
    if (parsed.success) ids.push(parsed.data);
  }
  return ids;
}

function listenersFor(taskId: string): DocumentHeadListener[] {
  return [...(listeners.get(taskId) ?? [])];
}

function allListeners(): DocumentHeadListener[] {
  return [...listeners.values()].flatMap((set) => [...set]);
}

const handlers = {
  onEvent(frame: { readonly type: string; readonly data: unknown }) {
    if (frame.type !== "document.head_changed") return;
    const parsed = documentHeadChangedEventSchema.safeParse(frame.data);
    if (!parsed.success) return;
    for (const listener of listenersFor(parsed.data.taskId)) listener.onHeadChanged(parsed.data);
  },
  onSnapshot(frame: { readonly data: unknown }) {
    const parsed = userTopicSnapshotSchema.safeParse(frame.data);
    if (!parsed.success) return;
    for (const [taskId, revision] of Object.entries(parsed.data.heads)) {
      for (const listener of listenersFor(taskId)) listener.onSnapshotHead?.(taskId, revision);
    }
  },
  onResync() {
    for (const listener of allListeners()) listener.onResync?.();
  },
};

function syncSubscription(realtime: RealtimeClient): void {
  const ids = openTaskIds();
  if (listeners.size === 0) {
    subscription?.unsubscribe();
    subscription = null;
    statusOff?.();
    statusOff = null;
    return;
  }
  if (subscription) {
    subscription.setOpenTasks(ids);
    return;
  }
  subscription = realtime.subscribeUser(ids, handlers);
  statusOff = realtime.onStatusChange((status) => {
    for (const listener of allListeners()) listener.onStatus?.(status);
  });
  realtime.connect();
}

/**
 * Watches one task's published head. Returns an unsubscribe function; the socket closes once the
 * last task page is gone (and only when this module created it).
 */
export function watchDocumentHead(taskId: string, listener: DocumentHeadListener): () => void {
  const realtime = sharedClient();
  if (!realtime) return () => undefined;
  const set = listeners.get(taskId) ?? new Set<DocumentHeadListener>();
  set.add(listener);
  listeners.set(taskId, set);
  syncSubscription(realtime);
  return () => {
    const current = listeners.get(taskId);
    if (!current?.delete(listener)) return;
    if (current.size === 0) listeners.delete(taskId);
    syncSubscription(realtime);
    if (listeners.size === 0 && owned && client) {
      client.disconnect();
      client = null;
      owned = false;
    }
  };
}

/** Test hook: forgets every listener and the shared client without touching an injected one. */
export function resetDocumentRealtime(): void {
  listeners.clear();
  subscription = null;
  statusOff?.();
  statusOff = null;
  if (owned && client) client.disconnect();
  client = null;
  owned = false;
}
