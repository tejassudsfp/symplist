-- Bug reports (§3.4 foundation): what somebody typed when something went wrong, and where.
--
-- A foundation table and not a feature one, because the report comes from every surface and belongs to
-- none of them: the signed-in workspace, the public site with nobody signed in, and the desktop shell
-- that loads the same web app. `abuse_counters` is in this range for the same reason — a table no
-- feature owns.
--
-- **The report text is the person's own words, so `report_enc` is a field envelope** (purpose
-- `bug_report`, table `bugs`, row id, column `report_enc`), exactly as `tasks.title_enc` and
-- `labels.name_enc` are. It is *not* under an account data key, and that is deliberate: a signed-out
-- visitor has no account and therefore no account data key, so making the account key the key for this
-- table would mean two key regimes in one column and a reader that needs both. Instead every row uses
-- one table key, `HKDF(CONTENT_KEK_<n>, "symplist/bug-report/v1")`. The envelope's AAD still binds the
-- reporter — their user id, or the literal `anonymous` — so a row lifted between reporters, tables,
-- rows or columns cannot be decrypted, and the whole write stays one D1 round trip because no
-- `account_keys` row has to be read first.
--
-- `kek_version` records which `CONTENT_KEK` version derived the key. The `sym1` envelope carries the
-- *data* key version (always 1) and nothing about the KEK, so without this column a `CONTENT_KEK`
-- rotation would leave every stored report unreadable. Account data keys do not need it because
-- rotation re-wraps them; a key derived straight from the KEK has nothing to re-wrap.
--
-- **The consequence to know:** deleting the account does not crypto-shred these rows, because they are
-- not under its data key. The account purge deletes them outright instead — see the account purge
-- contributor, where it is load-bearing rather than defensive: `reporter_id` references `users`, so a
-- leftover report would block the `users` delete.
CREATE TABLE bugs (
  id TEXT PRIMARY KEY NOT NULL,
  -- The reporter when there was one. Nullable: a visitor on the marketing site can report a bug
  -- without an account, which is exactly the case where the bug may be what stopped them signing in.
  reporter_id TEXT REFERENCES users (id),
  report_enc TEXT NOT NULL,
  kek_version INTEGER NOT NULL CHECK (kek_version >= 1),
  -- Which surface the report came from. Constrained because it is what a triage list groups by; the
  -- remaining context columns are free text a client fills in and are only ever read by a human.
  surface TEXT NOT NULL CHECK (surface IN ('workspace', 'site', 'desktop')),
  -- The route they were on, the build they were running, their platform, and the user agent the api
  -- saw. In the clear on purpose: none of it is the person's words, and a report nobody can place is a
  -- report nobody can act on. A path may contain a task id, which is an identifier and not content —
  -- the same thing request logs already hold.
  page TEXT,
  app_version TEXT,
  platform TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;

-- Triage order: newest reports first is the only way this table is ever read by hand.
CREATE INDEX bugs_recent ON bugs (created_at, id);
-- One reporter's reports: what the account purge deletes, and what answers "has this person written in
-- before" without scanning the table.
CREATE INDEX bugs_reporter ON bugs (reporter_id, created_at, id);
