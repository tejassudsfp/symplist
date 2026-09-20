-- Durable marker for the oldest message still carried into Simon's bounded model context. A nullable
-- additive column keeps the rollout compatible with conversations created before this migration.
ALTER TABLE conversations ADD COLUMN history_floor_seq INTEGER CHECK (history_floor_seq IS NULL OR history_floor_seq >= 1);
