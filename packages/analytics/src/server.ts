/**
 * Server analytics emitter (§15): one `posthog-node` client per process with `disableGeoip: true`,
 * the same allowlist as the client, and a stored-consent check before every capture.
 */
export {};
