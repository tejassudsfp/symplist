import { computeEmailSuppressionDigest, type KeyProvider } from "@symplist/crypto";
import { type DbClient, int, type Statement, sql, uuidv7 } from "@symplist/db";
import { z } from "zod";

export const resendReminderEvents = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "email.delivery_delayed",
] as const;
const eventSchema = z.object({
  type: z.enum(resendReminderEvents),
  created_at: z.iso.datetime({ offset: true }),
  data: z.object({
    email_id: z.string().min(1).max(255),
    to: z.array(z.email().max(320)).max(50),
    bounce: z.object({ type: z.string().max(50) }).optional(),
  }),
});

/** Called only after the provider's raw-body signature verifier. Never stores or logs provider content. */
export class ResendDeliveryEvents {
  constructor(
    readonly db: DbClient,
    readonly keys: KeyProvider,
    readonly now: () => number,
  ) {}
  async apply(receiptId: string, value: unknown): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(receiptId)) throw new Error("webhook.invalid");
    const event = eventSchema.parse(value);
    const w = uuidv7(this.now());
    const eventAt = Date.parse(event.created_at);
    const status = event.type === "email.complained" ? "suppressed" : event.type.slice(6);
    const params = {
      receipt: receiptId,
      w,
      provider: event.data.email_id,
      status,
      at: int(eventAt),
    };
    const guard =
      "EXISTS(SELECT 1 FROM webhook_receipts WHERE provider='resend' AND receipt_id=:receipt AND write_id=:w)";
    const statements: Statement[] = [
      sql(
        "INSERT INTO webhook_receipts(provider,receipt_id,event_type,received_at,write_id) VALUES('resend',:receipt,:type,:now,:w) ON CONFLICT(provider,receipt_id) DO NOTHING",
        { receipt: receiptId, type: event.type, now: int(this.now()), w },
      ),
      sql(
        `INSERT INTO notification_provider_events(provider_id,status,event_at,receipt_id,write_id) SELECT :provider,:status,:at,:receipt,:w WHERE ${guard}
        ON CONFLICT(provider_id) DO UPDATE SET status=excluded.status,event_at=excluded.event_at,receipt_id=excluded.receipt_id,write_id=excluded.write_id WHERE notification_provider_events.event_at<excluded.event_at`,
        params,
      ),
      sql(
        `UPDATE notification_outbox SET status=:status,provider_event_at=:at,write_id=:w WHERE provider_id=:provider AND (provider_event_at IS NULL OR provider_event_at<CAST(:at AS INTEGER)) AND ${guard}`,
        params,
      ),
    ];
    if (
      event.type === "email.complained" ||
      (event.type === "email.bounced" && event.data.bounce?.type === "Permanent")
    ) {
      for (const email of new Set(event.data.to.map((address) => address.trim().toLowerCase()))) {
        const digest = computeEmailSuppressionDigest(this.keys, email);
        statements.push(
          sql(
            `INSERT INTO email_suppressions(address_digest,digest_version,reason,created_at) SELECT :digest,:version,:reason,:now WHERE ${guard}
          ON CONFLICT(address_digest,digest_version) DO NOTHING`,
            {
              receipt: receiptId,
              w,
              digest: digest.digest,
              version: int(digest.version),
              reason: event.type === "email.complained" ? "complaint" : "bounce",
              now: int(this.now()),
            },
          ),
        );
        statements.push(
          sql(
            `UPDATE notification_outbox SET status='cancelled',write_id=:w WHERE owner_id IN (SELECT id FROM users WHERE email=:email) AND channel='email' AND status IN ('pending','claimed','uncertain') AND ${guard}`,
            { receipt: receiptId, w, email },
          ),
        );
      }
    }
    await this.db.batch(statements);
  }
  async reconcile(limit = 100): Promise<void> {
    // Handles a webhook racing provider acceptance persistence without retaining the webhook body.
    await this.db.run(
      sql(
        `UPDATE notification_outbox SET status=(SELECT status FROM notification_provider_events e WHERE e.provider_id=notification_outbox.provider_id),provider_event_at=(SELECT event_at FROM notification_provider_events e WHERE e.provider_id=notification_outbox.provider_id),write_id=:w
      WHERE id IN (SELECT b.id FROM notification_outbox b JOIN notification_provider_events e ON e.provider_id=b.provider_id WHERE b.provider_event_at IS NULL OR b.provider_event_at<e.event_at LIMIT :limit)`,
        { w: uuidv7(this.now()), limit: int(Math.min(100, limit)) },
      ),
    );
  }
}
