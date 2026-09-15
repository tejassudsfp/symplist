-- The local executor's idempotency guard (§8.1). The dispatcher sets `local_started_at`, conditional
-- on its claim, before it runs an intent in the api process; an intent that carries it is never
-- started in process again, so a job whose dispatch outcome was lost (a failed `markDispatched` or a
-- lost claim) lands on the execution that already ran, as Trigger's idempotency key does for durable
-- work. A start that fails before any job code runs clears it again.
ALTER TABLE dispatch_intents ADD COLUMN local_started_at INTEGER;
