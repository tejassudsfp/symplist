-- A reconnect to the same upstream id still invalidates the earlier approval (§8.4, §14.2).
ALTER TABLE approvals ADD COLUMN connection_generation INTEGER CHECK (connection_generation >= 1);
