# Privacy design and analytics

This document describes the privacy design of the released application. A deployment-specific privacy notice must identify its operator, contact channel, processing purposes, vendors/regions, retention, deletion, and analytics choices.

Task documents, chats, Vault entries, search indexes, and artifact snapshots follow the specified encryption-at-rest model. The authorized service can decrypt ordinary content and supports service-managed Vault recovery; user-only decryption is not promised. Sharing deliberately discloses a reviewed snapshot, and expiry cannot erase copies already fetched by recipients.

PostHog is selected for optional explicit product analytics. Default-off configuration and user opt-in are required. Private content, personal identifiers, secret URLs, authentication/Vault interactions, and artifact-recipient activity are excluded. Session replay and autocapture are disabled. See the [analytics specification](docs/notes/files/17_analytics.md) for event, identity, retention, and verification requirements.

Resend, connected services, model providers, and execution infrastructure process the data needed for their authorized functions. Analytics opt-out does not disable those functions or necessary security/operational records. Operators must document these distinctions accurately. Self-hosting does not require PostHog, billing, or a central hosted license check.
