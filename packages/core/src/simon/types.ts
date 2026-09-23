import type { AiProvider, simonRunStatusSchema } from "@symplist/contracts";
import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import type { DbClient, DbRow } from "@symplist/db";
import type { ReceiptDraft } from "@symplist/docs";
import type { AccessPolicy } from "../access/evaluate.ts";
import type { ExecutorKind } from "../events/execution.ts";

export type SimonRunStatus = typeof simonRunStatusSchema._output;
export type SimonTier = "fast" | "smart";
export class SimonError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SimonError";
  }
}

export interface SimonRepositoryOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly quickChatTtlHours: number;
}

export interface SimonRun {
  readonly id: string;
  readonly ownerId: string;
  readonly conversationId: string;
  readonly taskId: string | null;
  readonly kind: "turn" | "continuation" | "retry";
  readonly status: SimonRunStatus;
  readonly executor: ExecutorKind;
  readonly generation: number;
  readonly tier: SimonTier;
  readonly approvalId: string | null;
  readonly askId: string | null;
  readonly cancelRequestedAt: number | null;
}

export interface ClaimedSimonRun {
  readonly run: SimonRun;
  /** The caller destroys this key after the turn, including on error. */
  readonly key: AccountDataKey;
}

export interface SimonCheckpointData {
  /**
   * Why a `failed` checkpoint failed. Ignored for every other status.
   *
   * Defaults to `ai.provider_failed`, which is what a failure without an explanation is. A caller
   * that knows better says so, because "the provider broke" and "this account has no key" send the
   * reader to completely different places.
   */
  readonly outcomeCode?: "ai.provider_failed" | "ai.key_required";
  /** Native document receipts are persisted only with the step containing their tool results. */
  readonly receipts?: readonly ReceiptDraft[];
  readonly retrievedBytes?: number;
  /** A validated AI SDK UI message, stored only in an encrypted message_parts envelope. */
  readonly snapshotJson?: string;
  readonly telemetry?: {
    readonly provider: AiProvider | "scripted";
    readonly model: string;
    readonly rulesVersion: string;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
  };
}

export function runFromRow(row: DbRow): SimonRun {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    conversationId: String(row.conversation_id),
    taskId: row.task_id as string | null,
    kind: row.kind as SimonRun["kind"],
    status: row.status as SimonRunStatus,
    executor: row.executor as ExecutorKind,
    generation: Number(row.executor_generation),
    tier: row.tier as SimonTier,
    approvalId: row.approval_id as string | null,
    askId: row.ask_id as string | null,
    cancelRequestedAt: row.cancel_requested_at as number | null,
  };
}
