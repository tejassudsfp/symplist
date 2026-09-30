"use client";

import {
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

export type GrantList = z.infer<typeof mcpGrantListSchema>;
export type KeyResult = z.infer<typeof mcpKeyResultSchema>;
export type TaskPage = z.infer<typeof taskTreeResponseSchema>;
export type ConsentResult = z.infer<typeof oauthDecisionResultSchema>;
export interface AgentAccessApi {
  grants(signal: AbortSignal): Promise<GrantList>;
  createKey(body: McpCreateKey, key: string, signal: AbortSignal): Promise<KeyResult>;
  revoke(id: string, key: string, signal: AbortSignal): Promise<unknown>;
  tasks(collection: TaskCollection, cursor: string | null, signal: AbortSignal): Promise<TaskPage>;
  consent(id: string, signal: AbortSignal): Promise<OAuthConsentView>;
  decide(id: string, body: OAuthDecision, key: string, signal: AbortSignal): Promise<ConsentResult>;
}
export function createAgentAccessApi(client: () => ApiClient = getApiClient): AgentAccessApi {
  return {
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

export interface AgentAccessEnvironment {
  readonly api: AgentAccessApi;
  readonly realtime?: WorkspaceRealtimeSource | null;
  readonly navigate: (url: string) => void;
}
const shared: AgentAccessEnvironment = {
  api: createAgentAccessApi(),
  navigate: (url) => window.location.assign(url),
};
const Context = createContext(shared);
export function AgentAccessProvider({
  value,
  children,
}: {
  value: AgentAccessEnvironment;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAgentAccess() {
  return useContext(Context);
}
