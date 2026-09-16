-- Scheduling metadata is plaintext (§4.4); notification and immutable email content is encrypted.
CREATE TABLE task_schedules (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), owner_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL, deadline_kind TEXT CHECK(deadline_kind IN ('date','timed')),
  deadline_date TEXT, deadline_local TEXT, deadline_zone TEXT, deadline_at INTEGER,
  disambiguation TEXT, updated_at INTEGER NOT NULL, write_id TEXT NOT NULL,
  UNIQUE(task_id,owner_id)
) STRICT;
CREATE INDEX task_schedules_owner_deadline ON task_schedules(owner_id,deadline_at,task_id);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL,
  rule_json TEXT NOT NULL, channels_json TEXT NOT NULL, override_quiet INTEGER NOT NULL CHECK(override_quiet IN (0,1)),
  generation INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','cancelled')),
  created_at INTEGER NOT NULL, write_id TEXT NOT NULL,
  FOREIGN KEY(task_id,owner_id) REFERENCES task_schedules(task_id,owner_id), UNIQUE(id,owner_id)
) STRICT;
CREATE INDEX reminders_task ON reminders(owner_id,task_id,status);
CREATE TABLE reminder_occurrences (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL,
  reminder_id TEXT NOT NULL, generation INTEGER NOT NULL, intended_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','delivered','skipped','expired','cancelled','suppressed_access')),
  late INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL DEFAULT 0,
  executor_generation INTEGER, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, write_id TEXT NOT NULL,
  FOREIGN KEY(reminder_id,owner_id) REFERENCES reminders(id,owner_id), UNIQUE(id,owner_id)
) STRICT;
CREATE INDEX reminder_occurrences_due ON reminder_occurrences(status,intended_at,lease_until);
CREATE INDEX reminder_occurrences_task ON reminder_occurrences(owner_id,task_id,status,intended_at);
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('in_app','email')),
  deliver_after INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','accepted','delivered','bounced','failed','suppressed','delivery_delayed','expired','cancelled','uncertain')),
  provider_id TEXT, provider_event_at INTEGER, lease_owner TEXT, lease_until INTEGER,
  fence INTEGER NOT NULL DEFAULT 0, executor_generation INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER, created_at INTEGER NOT NULL, write_id TEXT NOT NULL,
  FOREIGN KEY(occurrence_id,owner_id) REFERENCES reminder_occurrences(id,owner_id), UNIQUE(occurrence_id,channel)
) STRICT;
CREATE INDEX notification_outbox_due ON notification_outbox(status,deliver_after,lease_until);
CREATE INDEX notification_outbox_provider ON notification_outbox(provider_id);
CREATE INDEX notification_outbox_owner ON notification_outbox(owner_id,status);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL REFERENCES tasks(id),
  occurrence_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reminder','missed')),
  text_enc TEXT NOT NULL, intended_at INTEGER NOT NULL, quiet INTEGER NOT NULL, late INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, last_occurrence_id TEXT NOT NULL,
  read_at INTEGER, dismissed_at INTEGER, created_at INTEGER NOT NULL, write_id TEXT NOT NULL,
  UNIQUE(occurrence_id,kind)
) STRICT;
CREATE UNIQUE INDEX notifications_unread_missed ON notifications(owner_id,task_id,kind) WHERE kind='missed' AND read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX notifications_owner ON notifications(owner_id,created_at,id);
CREATE TABLE notification_prefs (
  owner_id TEXT PRIMARY KEY REFERENCES users(id), version INTEGER NOT NULL,
  zone TEXT NOT NULL, default_hour INTEGER NOT NULL, in_app INTEGER NOT NULL, email INTEGER NOT NULL,
  quiet_enabled INTEGER NOT NULL, quiet_start INTEGER NOT NULL, quiet_end INTEGER NOT NULL,
  email_preview INTEGER NOT NULL, last_quiet_summary_at INTEGER, updated_at INTEGER NOT NULL, write_id TEXT NOT NULL
) STRICT;
CREATE TABLE email_suppressions (
  address_digest TEXT NOT NULL, digest_version INTEGER NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('bounce','complaint')),
  created_at INTEGER NOT NULL, PRIMARY KEY(address_digest,digest_version)
) STRICT;
CREATE TABLE schedule_audit (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL REFERENCES tasks(id),
  actor TEXT NOT NULL CHECK(actor IN ('user','simon','mcp')), version INTEGER NOT NULL,
  request_id TEXT NOT NULL, fingerprint_enc TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(owner_id,request_id)
) STRICT;
CREATE INDEX schedule_audit_task ON schedule_audit(owner_id,task_id,version);
