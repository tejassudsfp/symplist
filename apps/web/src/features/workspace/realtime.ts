"use client";

import {
  preferencesChangedEventSchema,
  tasksChangedEventSchema,
  userTopicSnapshotSchema,
} from "@symplist/contracts";
import { useEffect, useRef } from "react";
import { RealtimeClient, realtimeUrl, type TopicHandlers } from "@/lib/realtime";

/**
 * The workspace's view of the realtime socket (§7). Only the `user` topic matters here:
 * `tasks.changed` and `preferences.changed` tell this browser that the owner's tasks or preferences
 * moved, on this device, through Simon or through a connected agent, and the snapshot carries the
 * tree version after every (re)connect.
 */
export interface WorkspaceRealtimeHandlers {
  onTasksChanged(taskTreeVersion: number, taskIds: readonly string[]): void;
  onPreferencesChanged(group: string, version: number): void;
  /** A fresh `user` snapshot: the socket (re)connected, so loaded state may be stale. */
  onSnapshot(taskTreeVersion: number): void;
}

/** The socket the workspace subscribes to; a fake implements it in tests. */
export interface WorkspaceRealtimeSource {
  subscribeUser(handlers: TopicHandlers): () => void;
}

let sharedClient: RealtimeClient | null = null;

/**
 * The browser's realtime client. One socket per document: every feature that needs the `user` topic
 * shares this client instead of opening a socket of its own. It belongs in `lib/realtime` once a
 * second feature needs it; it lives here because the workspace is the first (§7, decision W7).
 */
export function workspaceRealtimeSource(): WorkspaceRealtimeSource | null {
  const client = workspaceRealtimeClient();
  if (!client) return null;
  return {
    subscribeUser(handlers) {
      const subscription = client.subscribeUser([], handlers);
      client.connect();
      return () => subscription.unsubscribe();
    },
  };
}

/** Conversation listeners share the owner's existing socket; never another connection per chat. */
export function workspaceRealtimeClient(): RealtimeClient | null {
  if (typeof window === "undefined") return null;
  if (!sharedClient) {
    const url = realtimeUrl();
    if (!url) return null;
    sharedClient = new RealtimeClient({ url });
  }
  return sharedClient;
}

/**
 * Drops the shared socket, so the next `workspaceRealtimeSource()` opens a fresh one (decision W7).
 * An in-document account change must do this: the socket carries the *previous* account's admitted
 * state, and a sign-out that revokes server-side would only close it with 4401 some time later. The
 * next source builds a new client, which authenticates as whoever is signed in now.
 */
export function closeSharedRealtimeClient(): void {
  const client = sharedClient;
  sharedClient = null;
  client?.disconnect();
}

/** Test seam: replaces the shared client so no test opens a real socket. */
export function resetSharedRealtimeClient(client: RealtimeClient | null = null): void {
  sharedClient = client;
}

/**
 * Subscribes to the `user` topic for as long as the component is mounted. The subscription is made
 * once per source: handlers are read through a ref, so a re-render never resubscribes the topic.
 */
export function useWorkspaceRealtime(
  handlers: WorkspaceRealtimeHandlers,
  source: WorkspaceRealtimeSource | null | undefined,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!source) return;
    return source.subscribeUser({
      onEvent: (frame) => {
        if (frame.type === "tasks.changed") {
          const parsed = tasksChangedEventSchema.safeParse(frame.data);
          if (parsed.success) {
            latest.current.onTasksChanged(parsed.data.taskTreeVersion, parsed.data.taskIds);
          }
          return;
        }
        if (frame.type === "preferences.changed") {
          const parsed = preferencesChangedEventSchema.safeParse(frame.data);
          if (parsed.success) {
            latest.current.onPreferencesChanged(parsed.data.group, parsed.data.version);
          }
        }
      },
      onSnapshot: (frame) => {
        const parsed = userTopicSnapshotSchema.safeParse(frame.data);
        if (parsed.success) latest.current.onSnapshot(parsed.data.taskTreeVersion);
      },
    });
  }, [source]);
}
