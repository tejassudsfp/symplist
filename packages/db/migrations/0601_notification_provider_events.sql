ALTER TABLE webhook_receipts ADD COLUMN write_id TEXT;
CREATE TABLE notification_provider_events (
  provider_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('delivered','bounced','suppressed','failed','delivery_delayed')),
  event_at INTEGER NOT NULL,
  receipt_id TEXT NOT NULL,
  write_id TEXT NOT NULL
) STRICT;
CREATE INDEX notification_provider_events_time ON notification_provider_events(event_at);
