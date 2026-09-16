-- Retry checks direct descendants while atomically claiming an idle conversation (§8.1).
CREATE INDEX runs_continues ON runs (continues_run_id);
CREATE INDEX approvals_run_history ON approvals (run_id, created_at, id);
CREATE INDEX user_asks_run_history ON user_asks (run_id, created_at, id);
