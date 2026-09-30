# Privacy design and analytics

This document describes the privacy design of the released application. A deployment-specific privacy notice must identify its operator, contact channel, processing purposes, vendors/regions, retention, deletion, and analytics choices.

Task documents, task and label names, Vault entries, search indexes, and artifact snapshots follow the specified encryption-at-rest model. The authorized service can decrypt ordinary content and supports service-managed Vault recovery; user-only decryption is not promised. Sharing deliberately discloses a reviewed snapshot, and expiry cannot erase copies already fetched by recipients.

Durable execution once carried an exception worth stating plainly, and no longer does. When a deployment ran an assistant as a durable chat session, the turn's messages and streamed output passed through the execution provider's realtime streams. No deployment runs an assistant now: durable execution covers only background jobs — Git commits, index rebuilds, reminder scans, purges — whose payloads, outputs and tags are ids, enums and counts, with encrypted content returning through a signed worker-to-API relay. Nothing a person wrote transits the execution provider in plaintext.

No deployment holds a model credential, and the configuration refuses to boot if one is set. The assistant is whichever MCP client the person points at their workspace; that client holds the model key, calls the provider directly, and is governed by its own vendor's terms rather than by this one.

PostHog is selected for optional explicit product analytics. Default-off configuration and user opt-in are required. Private content, personal identifiers, secret URLs, authentication/Vault interactions, and artifact-recipient activity are excluded. Session replay and autocapture are disabled. See the [analytics specification](docs/notes/files/17_analytics.md) for event, identity, retention, and verification requirements.

Resend and execution infrastructure process the data needed for their authorized functions. Model providers are not in this list: no deployment calls one. Analytics opt-out does not disable those functions or necessary security/operational records. Operators must document these distinctions accurately. Self-hosting does not require PostHog, billing, or a central hosted license check.
