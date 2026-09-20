-- Webhook deduplication (§6.2): svix-id (Resend) or webhook-id (Composio), inserted in the same
-- batch as the webhook's effect.
CREATE TABLE webhook_receipts (
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'composio')),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 255),
  event_type TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (provider, receipt_id)
) STRICT;

CREATE INDEX webhook_receipts_received ON webhook_receipts (received_at);
