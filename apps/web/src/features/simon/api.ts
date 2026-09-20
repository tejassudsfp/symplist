import {
  type simonApprovalDecisionSchema,
  simonApprovalViewSchema,
  simonAskViewSchema,
  simonConversationCreatedSchema,
  simonConversationViewSchema,
  simonMessageAcceptedSchema,
  type simonMessageInputSchema,
  simonQuickClosedSchema,
  simonQuickSavedSchema,
  type simonQuickSaveInputSchema,
  simonRunCommandResultSchema,
} from "@symplist/contracts";
import { type ApiClient, getApiClient } from "@/lib/api";

export function createSimonApi(client: () => ApiClient = getApiClient) {
  const path = (id: string) => `/v1/conversations/${encodeURIComponent(id)}`;
  return {
    create: (taskId: string | null, idempotencyKey: string) =>
      client().post("/v1/conversations", {
        body: taskId ? { kind: "task", taskId } : { kind: "quick" },
        idempotencyKey,
        schema: simonConversationCreatedSchema,
      }),
    history: (id: string, beforeSeq?: number) =>
      client().get(path(id), {
        schema: simonConversationViewSchema,
        ...(beforeSeq === undefined ? {} : { query: { beforeSeq } }),
      }),
    send: (id: string, body: typeof simonMessageInputSchema._output, idempotencyKey: string) =>
      client().post(`${path(id)}/messages`, {
        body,
        idempotencyKey,
        schema: simonMessageAcceptedSchema,
      }),
    stop: (id: string, idempotencyKey: string) =>
      client().post(`/v1/runs/${encodeURIComponent(id)}/stop`, {
        idempotencyKey,
        schema: simonRunCommandResultSchema,
      }),
    retry: (id: string, idempotencyKey: string) =>
      client().post(`/v1/runs/${encodeURIComponent(id)}/retry`, {
        idempotencyKey,
        schema: simonRunCommandResultSchema,
      }),
    close: (id: string, idempotencyKey: string) =>
      client().delete(path(id), { idempotencyKey, schema: simonQuickClosedSchema }),
    save: (id: string, body: typeof simonQuickSaveInputSchema._output, idempotencyKey: string) =>
      client().post(`${path(id)}/save-as-task`, {
        body,
        idempotencyKey,
        schema: simonQuickSavedSchema,
      }),
    approval: (id: string) =>
      client().get(`/v1/approvals/${encodeURIComponent(id)}`, { schema: simonApprovalViewSchema }),
    decide: (
      id: string,
      body: typeof simonApprovalDecisionSchema._output,
      idempotencyKey: string,
    ) =>
      client().post(`/v1/approvals/${encodeURIComponent(id)}/decision`, { body, idempotencyKey }),
    ask: (id: string) =>
      client().get(`/v1/user-asks/${encodeURIComponent(id)}`, { schema: simonAskViewSchema }),
    answer: (id: string, text: string, idempotencyKey: string) =>
      client().post(`/v1/user-asks/${encodeURIComponent(id)}/answer`, {
        body: { text },
        idempotencyKey,
        schema: simonRunCommandResultSchema,
      }),
    dismiss: (id: string, idempotencyKey: string) =>
      client().post(`/v1/user-asks/${encodeURIComponent(id)}/dismiss`, {
        idempotencyKey,
        schema: simonRunCommandResultSchema,
      }),
  };
}
export type SimonApi = ReturnType<typeof createSimonApi>;
export function simonErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "ai.unavailable")
    return "Simon is not configured on this server yet. Your conversation is still available.";
  if (code === "approval.stale")
    return "This action changed or expired. Reload it and review the current details.";
  if (code === "not_found" || code === "simon.conversation_expired")
    return "This conversation is no longer available.";
  if (code === "task.archived")
    return "This task is archived. Restore it before sending another message.";
  return "Could not confirm this request. Check your connection, then retry the same request.";
}
