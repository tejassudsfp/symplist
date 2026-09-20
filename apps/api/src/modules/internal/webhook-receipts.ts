import { type DbClient, int, type Statement, type StatementResult, sql } from "@symplist/db";

/** Providers with a `webhook_receipts` row per delivery (§6.2, §12.5, §14.3). */
export type WebhookProvider = "resend" | "composio";

/** The condition every effect statement adds to its `WHERE`, with its named parameters. */
export interface WebhookReceiptGuard {
  /** `NOT EXISTS (…)` over this delivery's receipt. */
  readonly notReceived: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface WebhookReceiptInput {
  readonly provider: WebhookProvider;
  /** `svix-id` (Resend) or `webhook-id` (Composio). */
  readonly receiptId: string;
  readonly eventType: string | null;
  readonly receivedAt: number;
  /** The webhook's effect, each statement guarded by `guard.notReceived`. */
  effects(guard: WebhookReceiptGuard): readonly Statement[];
}

export interface WebhookReceiptBatch {
  readonly statements: readonly Statement[];
  /** Reads the batch results: whether this delivery was already recorded, and the effect results. */
  outcome(results: readonly StatementResult[]): WebhookReceiptOutcome;
}

export interface WebhookReceiptOutcome {
  readonly duplicate: boolean;
  readonly effectResults: readonly StatementResult[];
}

const receiptIdPattern = /^[\x21-\x7e]{1,255}$/;

/**
 * Builds the one batch that records a webhook delivery together with its effect (§6.2): a probe of the
 * receipt, the effect statements guarded by `NOT EXISTS` on the receipt, then the receipt insert
 * (`ON CONFLICT DO NOTHING`). D1 runs a batch in order as one transaction, so a redelivery, even a
 * concurrent one, finds the receipt and applies nothing.
 */
export function webhookReceiptBatch(input: WebhookReceiptInput): WebhookReceiptBatch {
  if (input.provider !== "resend" && input.provider !== "composio") {
    throw new Error("Unknown webhook provider");
  }
  if (typeof input.receiptId !== "string" || !receiptIdPattern.test(input.receiptId)) {
    throw new Error("Webhook receipt ids are 1-255 printable ASCII characters");
  }
  const params = { receipt_provider: input.provider, receipt_id: input.receiptId };
  const guard: WebhookReceiptGuard = {
    notReceived:
      "NOT EXISTS (SELECT 1 FROM webhook_receipts WHERE provider = :receipt_provider AND receipt_id = :receipt_id)",
    params,
  };
  const effects = input.effects(guard);
  for (const statement of effects) {
    if (
      !/NOT EXISTS \(SELECT 1 FROM webhook_receipts WHERE provider = \? AND receipt_id = \?\)/.test(
        statement.sql,
      )
    ) {
      throw new Error("Every webhook effect statement must include the receipt guard");
    }
  }
  const statements: Statement[] = [
    sql(
      "SELECT 1 AS received FROM webhook_receipts WHERE provider = :receipt_provider AND receipt_id = :receipt_id",
      params,
    ),
    ...effects,
    sql(
      `INSERT INTO webhook_receipts (provider, receipt_id, event_type, received_at)
       VALUES (:receipt_provider, :receipt_id, :event_type, :received_at)
       ON CONFLICT (provider, receipt_id) DO NOTHING`,
      { ...params, event_type: input.eventType, received_at: int(input.receivedAt) },
    ),
  ];
  return {
    statements,
    outcome(results) {
      if (results.length !== statements.length) {
        throw new Error("The webhook receipt batch returned an unexpected number of results");
      }
      return {
        duplicate: (results[0]?.results.length ?? 0) > 0,
        effectResults: results.slice(1, 1 + effects.length),
      };
    },
  };
}

/** Runs a webhook receipt batch in one D1 request. */
export async function recordWebhookDelivery(
  db: DbClient,
  input: WebhookReceiptInput,
): Promise<WebhookReceiptOutcome> {
  const batch = webhookReceiptBatch(input);
  return batch.outcome(await db.batch(batch.statements));
}
