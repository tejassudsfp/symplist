-- Per-connection owner preference for when Simon must stop and ask (§14.2). Reading a mailbox and
-- sending from it were both gated, which taught owners to approve without reading; separating them
-- keeps attention on the actions that actually leave the account.
-- NULL is the strict default, so every connection that predates this column keeps asking every
-- time. Only 'reads' relaxes anything, and never a write: the policy still requires the provider's
-- own read-only tag and refuses any argument carrying a recipient, URL or body.
ALTER TABLE connections ADD COLUMN approval_mode TEXT
  CHECK (approval_mode IS NULL OR approval_mode IN ('all', 'reads'));
