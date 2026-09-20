/**
 * Analytics event allowlist schemas, the payload scrubber, the posthog-js configuration and the
 * consent-gated browser `track()` wrapper (§15). Browser-safe: nothing reachable from this entry
 * point imports `node:*`, and posthog-js is loaded dynamically only after consent. The server
 * emitter is `@symplist/analytics/server`.
 */
export {
  type AnalyticsConsentState,
  type ApplyConsentOutcome,
  type BrowserAnalytics,
  type BrowserAnalyticsOptions,
  createBrowserAnalytics,
  excludedAnalyticsPathPrefixes,
  isExcludedAnalyticsPath,
  type PostHogBrowserClient,
  removePostHogStorageKeys,
  type TrackOutcome,
} from "./browser.ts";
export {
  applicationProperties,
  checkOutgoingEvent,
  clientBeforeSend,
  createPostHogConfig,
  type PostHogConfigOptions,
  posthogUsAppHost,
  posthogUsIngestHost,
} from "./config.ts";
export * from "./events.ts";
export * from "./scrub.ts";
