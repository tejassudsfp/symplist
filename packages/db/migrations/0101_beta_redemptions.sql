-- Invite redemptions (§5.4): the redemption row is the seat. One conditional INSERT … SELECT claims
-- seat COUNT(*) + 1 while the invite is valid and the account is verified, locked and not suspended;
-- UNIQUE (invite_id, seat_no) makes a concurrent claim for the final seat fail, UNIQUE (user_id,
-- access_epoch) keeps two codes from admitting one account twice, and UNIQUE (request_id) makes a
-- retried request find its own row. Rows are never deleted, not even by the account purge: a seat
-- is never refunded (§5.4), so user_id carries no foreign key and outlives the account.
CREATE TABLE beta_redemptions (
  id TEXT PRIMARY KEY NOT NULL,
  invite_id TEXT NOT NULL REFERENCES beta_invites (id),
  seat_no INTEGER NOT NULL CHECK (seat_no >= 1),
  user_id TEXT NOT NULL,
  -- users.access_epoch when the seat was claimed; Restore eligibility moves the epoch (§5.4).
  access_epoch INTEGER NOT NULL CHECK (access_epoch >= 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  redeemed_at INTEGER NOT NULL,
  UNIQUE (invite_id, seat_no),
  UNIQUE (user_id, access_epoch),
  UNIQUE (request_id)
) STRICT;

CREATE INDEX beta_redemptions_redeemed ON beta_redemptions (redeemed_at);
