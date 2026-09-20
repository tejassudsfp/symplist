"use client";

import {
  type ConnectionStart,
  connectionCatalogueSchema,
  connectionStartResultSchema,
  connectionsListSchema,
  type McpCreateKey,
  mcpGrantListSchema,
  mcpKeyResultSchema,
  type OAuthConsentView,
  type OAuthDecision,
  oauthConsentViewSchema,
  oauthDecisionResultSchema,
  type TaskCollection,
  taskTreeResponseSchema,
} from "@symplist/contracts";
import { createContext, type ReactNode, useContext } from "react";
import { z } from "zod";
import type { WorkspaceRealtimeSource } from "@/features/workspace/realtime";
import { type ApiClient, getApiClient } from "@/lib/api";

export type ConnectionList = z.infer<typeof connectionsListSchema>;
export type Catalogue = z.infer<typeof connectionCatalogueSchema>;
export type ConnectResult = z.infer<typeof connectionStartResultSchema>;
export type GrantList = z.infer<typeof mcpGrantListSchema>;
export type KeyResult = z.infer<typeof mcpKeyResultSchema>;
export type TaskPage = z.infer<typeof taskTreeResponseSchema>;
export type ConsentResult = z.infer<typeof oauthDecisionResultSchema>;
export interface ConnectionsApi {
  list(signal: AbortSignal): Promise<ConnectionList>;
  catalogue(signal: AbortSignal): Promise<Catalogue>;
  start(body: ConnectionStart, key: string, signal: AbortSignal): Promise<ConnectResult>;
  disconnect(id: string, key: string, signal: AbortSignal): Promise<unknown>;
  grants(signal: AbortSignal): Promise<GrantList>;
  createKey(body: McpCreateKey, key: string, signal: AbortSignal): Promise<KeyResult>;
  revoke(id: string, key: string, signal: AbortSignal): Promise<unknown>;
  tasks(collection: TaskCollection, cursor: string | null, signal: AbortSignal): Promise<TaskPage>;
  consent(id: string, signal: AbortSignal): Promise<OAuthConsentView>;
  decide(id: string, body: OAuthDecision, key: string, signal: AbortSignal): Promise<ConsentResult>;
}
export function createConnectionsApi(client: () => ApiClient = getApiClient): ConnectionsApi {
  return {
    list: (signal) => client().get("/v1/connections", { signal, schema: connectionsListSchema }),
    catalogue: (signal) =>
      client().get("/v1/connections/catalogue", { signal, schema: connectionCatalogueSchema }),
    start: (body, idempotencyKey, signal) =>
      client().post("/v1/connections", {
        body,
        idempotencyKey,
        signal,
        schema: connectionStartResultSchema,
      }),
    disconnect: (id, idempotencyKey, signal) =>
      client().delete(`/v1/connections/${encodeURIComponent(id)}`, {
        idempotencyKey,
        signal,
        schema: z.object({ id: z.string(), status: z.literal("disconnected") }),
      }),
    grants: (signal) => client().get("/v1/mcp/grants", { signal, schema: mcpGrantListSchema }),
    createKey: (body, idempotencyKey, signal) =>
      client().post("/v1/mcp/grants", { body, idempotencyKey, signal, schema: mcpKeyResultSchema }),
    revoke: (id, idempotencyKey, signal) =>
      client().delete(`/v1/mcp/grants/${encodeURIComponent(id)}`, {
        idempotencyKey,
        signal,
        schema: z.object({ id: z.string(), revoked: z.literal(true) }),
      }),
    tasks: (collection, cursor, signal) =>
      client().get("/v1/tasks", {
        signal,
        query: { collection, ...(cursor ? { cursor } : {}) },
        schema: taskTreeResponseSchema,
      }),
    consent: (id, signal) =>
      client().get(`/v1/oauth/requests/${encodeURIComponent(id)}`, {
        signal,
        schema: oauthConsentViewSchema,
      }),
    decide: (id, body, idempotencyKey, signal) =>
      client().post(`/v1/oauth/requests/${encodeURIComponent(id)}/decision`, {
        body,
        idempotencyKey,
        signal,
        schema: oauthDecisionResultSchema,
      }),
  };
}

export interface ConnectionsEnvironment {
  readonly api: ConnectionsApi;
  readonly realtime?: WorkspaceRealtimeSource | null;
  readonly navigate: (url: string) => void;
}
const shared: ConnectionsEnvironment = {
  api: createConnectionsApi(),
  navigate: (url) => window.location.assign(url),
};
const Context = createContext(shared);
export function ConnectionsProvider({
  value,
  children,
}: {
  value: ConnectionsEnvironment;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useConnectionsEnvironment() {
  return useContext(Context);
}

/** Provider URLs are external navigation only, never HTML, embedded frames or API fetch targets. */
export function hostedAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid authorization address");
  return url.href;
}
