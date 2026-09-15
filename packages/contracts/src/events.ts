import { accessEvents } from "./access/events.ts";
import { analyticsEvents } from "./analytics/events.ts";
import type { EventUnion, ServerFrame } from "./common/ws.ts";
import { connectionsEvents } from "./connections/events.ts";
import { documentsEvents } from "./documents/events.ts";
import { schedulingEvents } from "./scheduling/events.ts";
import { searchEvents } from "./search/events.ts";
import { sharingEvents } from "./sharing/events.ts";
import { simonEvents } from "./simon/events.ts";
import { vaultEvents } from "./vault/events.ts";
import { workspaceEvents } from "./workspace/events.ts";

/** WebSocket event schemas by owning feature, so tests can prove event types are unique. */
export const wsEventsByFeature = {
  access: accessEvents,
  workspace: workspaceEvents,
  documents: documentsEvents,
  search: searchEvents,
  simon: simonEvents,
  scheduling: schedulingEvents,
  vault: vaultEvents,
  sharing: sharingEvents,
  connections: connectionsEvents,
  analytics: analyticsEvents,
} as const;

/** Every WebSocket event data schema, keyed by event type (§7). */
export const wsEvents = Object.freeze({
  ...accessEvents,
  ...workspaceEvents,
  ...documentsEvents,
  ...searchEvents,
  ...simonEvents,
  ...schedulingEvents,
  ...vaultEvents,
  ...sharingEvents,
  ...connectionsEvents,
  ...analyticsEvents,
});

/** The union of every WebSocket event, composed from the per-feature event files. */
export type WsEvent = EventUnion<typeof wsEvents>;

/** A server frame carrying any composed WebSocket event. */
export type WsServerFrame = ServerFrame<WsEvent>;
