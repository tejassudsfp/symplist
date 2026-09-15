# Product analytics — PostHog

Confirmed provider: PostHog. Specification only; there is no application SDK integration yet. Product analytics is independent of disabled beta billing/AI quota monitoring and optional AI operational telemetry.

## Collection boundary

Use explicit versioned events through a shared analytics wrapper with an allowlist of event names and property schemas. Suggested events: task_created, task_completed, task_moved, search_used, appearance_changed, reminder_created, handoff_prepared, artifact_share_created. Emit on confirmed successful actions; include an event ID for deduplication. Only enumerated properties such as source collection, destination collection, theme ID, preset-versus-custom accent, mode, channel, and share mode are permitted. Do not send actual custom colors or task/artifact IDs when a count/category suffices.

Never collect user text, titles, document bodies, chats, prompts, tool inputs/outputs, search queries, email/name, Vault information, passwords/OTPs, invite/share tokens, URL paths/query strings/fragments, raw exceptions, or external account identities. Use coarse outcome codes and duration buckets where justified. Only confirmed owner-side share creation is measured; no recipient-view analytics.

Disable autocapture, session replay, automatic pageviews/pageleave, automatic exception capture, heatmaps, surveys, and AI/LLM tracing. Do not rely on masking after capture. The chosen SDK's generated default properties (URLs/referrers and other metadata) must also be stripped before transmission using a strict final-payload schema; explicit events alone do not guarantee this. Pin the SDK, inspect outgoing requests, and test remote configuration cannot re-enable capture. Consider a server-only capture adapter if client defaults cannot meet the contract.

No client SDK on login/OTP, Vault, public/password/link-only artifact routes, or access-code forms. Do not emit analytics for those interactions from server code either. App-wide analytics providers must not accidentally mount on excluded layouts. Restrict Content Security Policy origins to the configured collector only where needed.

## Identity and user choice

Analytics is disabled until the deployment is explicitly configured and a user enables optional product analytics in Settings → Account → Privacy. The default self-hosted configuration is off. Consent controls are independent of access, reminders, and AI availability. No event queue may collect pre-consent behavior and replay it later. Opt-out prevents browser and server events, clears local analytics state, and is respected across sessions.

When enabled, use a random analytics-only identifier, separate from account IDs, with an account-side protected mapping solely for consent/deletion. Do not identify by email or send profile properties. Disable person-profile creation where supported; identifiers are pseudonymous, not a guarantee of anonymity. Reset identity on signout/account change; retain no cross-account queue. Account deletion invokes the provider deletion workflow according to a documented retention policy. Select and disclose collector region, retention, and subprocessors before operating the service. Configure 30-day event retention where available; otherwise document and enforce an equivalent deletion schedule before launch. Do not claim legal compliance solely from SDK configuration.

## Configuration and operation

Proposed settings: ANALYTICS_ENABLED=false, POSTHOG_PROJECT_KEY, POSTHOG_HOST. Read from a validated server-owned configuration source; expose only the project ingest key and host to the client if necessary. Administrative/personal API keys are server-only and separate. No project, paid account, or provider credentials are required when disabled. A configured project never overrides per-user consent.

Use bounded asynchronous delivery; analytics failures must never block task writes or access. No unbounded retries, content-bearing dead-letter records, or double capture from frontend plus backend. Choose one owner per event. Under DURABLE=true, emit agent-related product outcomes through the same server wrapper; never enable blanket Trigger/model-provider tracing as a side effect. Platform infrastructure logs have separate retention and redaction rules.

## Build checks

Test disabled mode makes zero collector requests; denied/revoked consent suppresses all emitters; excluded routes never initialize the client; schema rejects free text/unknown properties; SDK defaults contain no private URL/referrer/content; queue resets on account change; provider failure is nonblocking; deletion and retention work; duplicate event replay is bounded; there are no plan gates. Update the user-facing privacy notice with actual deployment details before launch.

Verify current pinned SDK behavior against [PostHog privacy guidance](https://posthog.com/docs/privacy), [JavaScript configuration](https://posthog.com/docs/libraries/js/config), and [person profiles](https://posthog.com/docs/data/persons). These are implementation requirements, not tests already run.
