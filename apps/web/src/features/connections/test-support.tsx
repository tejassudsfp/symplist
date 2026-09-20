import { taskTreeResponseSchema } from "@symplist/contracts";
import { type ReactNode, StrictMode } from "react";
import { vi } from "vitest";
import { mayaMe, renderAccess } from "@/features/access/test-support";
import { type ConnectionsApi, type ConnectionsEnvironment, ConnectionsProvider } from "./api.tsx";

export const id = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b81";
export const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b82";
export const secretMarker = "sym_test_only_private_key_marker";
export const toolkit = {
  slug: "gmail",
  name: "Gmail",
  description: "Read and send email",
  auth: "managed" as const,
};
export const grant = {
  id,
  kind: "api_key" as const,
  name: "Research helper",
  scopes: ["tasks:read" as const],
  taskIds: [taskId],
  createdAt: 1,
  lastUsedAt: null,
  expiresAt: Date.now() + 86_400_000,
  revokedAt: null,
};
export function fakeConnectionsApi(overrides: Partial<ConnectionsApi> = {}): ConnectionsApi {
  return {
    list: vi.fn(async () => ({ enabled: true, connections: [] })),
    catalogue: vi.fn(async () => ({ enabled: true, items: [toolkit] })),
    start: vi.fn(async () => ({
      attemptId: id,
      expiresAt: Date.now() + 600_000,
      url: "https://provider.example/connect",
      secretUnavailable: false,
    })),
    disconnect: vi.fn(async () => ({ id, status: "disconnected" })),
    grants: vi.fn(async () => ({ server: "https://api.example/mcp", grants: [] })),
    createKey: vi.fn(async () => ({
      id,
      key: secretMarker,
      expiresAt: Date.now() + 86_400_000,
      secretUnavailable: false,
    })),
    revoke: vi.fn(async () => ({ id, revoked: true })),
    tasks: vi.fn(async (collection) =>
      taskTreeResponseSchema.parse({
        collection,
        taskTreeVersion: 1,
        nextCursor: null,
        tasks: [
          {
            id: taskId,
            title: "Plan a quiet weekend",
            parentId: null,
            collection,
            position: "a0",
            depth: 0,
            preview: null,
            source: "user",
            version: 1,
            childCount: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ),
    consent: vi.fn(async () => ({
      id,
      clientName: "Research client",
      unverified: true,
      metadataHost: "agent.example",
      redirectHost: "localhost",
      loopbackOnly: true,
      scopes: ["tasks:read" as const],
      offlineAccess: true,
      expiresAt: Date.now() + 600_000,
    })),
    decide: vi.fn(async () => ({
      requestId: id,
      redirectUrl: "http://localhost:4321/callback?code=test",
      secretUnavailable: false,
    })),
    ...overrides,
  };
}
export function renderConnections(
  children: ReactNode,
  api = fakeConnectionsApi(),
  environment: Partial<ConnectionsEnvironment> = {},
) {
  const navigate = vi.fn();
  const value = { api, realtime: null, navigate, ...environment };
  return {
    ...renderAccess(
      <StrictMode>
        <ConnectionsProvider value={value}>{children}</ConnectionsProvider>
      </StrictMode>,
      { me: mayaMe() },
    ),
    connectionsApi: api,
    navigate,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
