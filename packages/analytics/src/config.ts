import type { CaptureResult, PostHogConfig } from "posthog-js";
import { eventVersionProperty, isAnalyticsEventName, validateAnalyticsEvent } from "./events.ts";
import { scrubEvent } from "./scrub.ts";

/** PostHog US cloud ingestion host (research C4). */
export const posthogUsIngestHost = "https://us.i.posthog.com";
/** PostHog US cloud app and private API host (research C4). */
export const posthogUsAppHost = "https://us.posthog.com";

/** SDK-generated events the client lets through; everything else must be an allowlisted event. */
const allowedSdkEvents: ReadonlySet<string> = new Set(["$identify"]);

/** Properties posthog-js adds without a `$` prefix. */
const sdkPlainProperties: ReadonlySet<string> = new Set(["token", "distinct_id"]);

/**
 * Splits the application's properties from SDK-added ones (`$`-prefixed and `token`,
 * `distinct_id`) so the application part can be checked against the event schema.
 */
export function applicationProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties ?? {})) {
    if (name.startsWith("$") || sdkPlainProperties.has(name)) continue;
    own[name] = value;
  }
  return own;
}

/**
 * The final check before an event leaves the page or process: only allowlisted events whose
 * application properties still match their schema pass, and every property bag is scrubbed.
 */
export function checkOutgoingEvent<
  Event extends { event: string; properties?: Record<string, unknown> },
>(owner: "client" | "server", event: Event, sdkEvents: ReadonlySet<string>): boolean {
  if (sdkEvents.has(event.event)) {
    // SDK events (only `$identify`) carry no application properties: anything that is not an SDK
    // property is removed, so a registered super property can never ride along.
    for (const name of Object.keys(applicationProperties(event.properties))) {
      delete event.properties?.[name];
    }
    return true;
  }
  if (!isAnalyticsEventName(event.event)) return false;
  const { [eventVersionProperty]: version, ...own } = applicationProperties(event.properties);
  const validation = validateAnalyticsEvent(owner, event.event, own);
  return validation.ok && validation.properties[eventVersionProperty] === version;
}

/** `before_send` for posthog-js: event allowlist plus property scrubber (§15). */
export function clientBeforeSend(event: CaptureResult | null): CaptureResult | null {
  if (event === null) return null;
  const scrubbed = scrubEvent(event);
  return checkOutgoingEvent("client", scrubbed, allowedSdkEvents) ? scrubbed : null;
}

export interface PostHogConfigOptions {
  /** Ingestion host; defaults to PostHog US cloud. Must be https. */
  readonly apiHost?: string;
}

/**
 * The exact posthog-js configuration (§15, research C1): nothing automatic, no remote config, no
 * external scripts, no referrer or campaign capture, localStorage persistence only after opt-in, and
 * the allowlist-plus-scrubber `before_send`.
 */
export function createPostHogConfig(options: PostHogConfigOptions = {}): Partial<PostHogConfig> {
  const apiHost = options.apiHost ?? posthogUsIngestHost;
  const parsed = new URL(apiHost);
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search !== "") {
    throw new Error("The PostHog api host must be an https origin");
  }
  return {
    api_host: parsed.origin,
    ui_host: posthogUsAppHost,
    defaults: "2026-08-30",
    opt_out_capturing_by_default: true,
    opt_out_persistence_by_default: true,
    persistence: "localStorage",
    person_profiles: "identified_only",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_performance: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    save_referrer: false,
    save_campaign_params: false,
    mask_personal_data_properties: true,
    property_denylist: [
      "$current_url",
      "$host",
      "$pathname",
      "$referrer",
      "$referring_domain",
      "$search_engine",
      "$raw_user_agent",
      "$screen_height",
      "$screen_width",
      "$viewport_height",
      "$viewport_width",
    ],
    before_send: clientBeforeSend,
  } satisfies Partial<PostHogConfig>;
}
