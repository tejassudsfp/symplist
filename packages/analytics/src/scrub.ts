/**
 * The payload scrubber (§15, research C1). PostHog SDKs add URL, path, referrer, host, campaign and
 * click-id properties to events and to `$set`/`$set_once`, even with `save_referrer` and
 * `save_campaign_params` off. This removes them from every property bag before transmission, and as
 * defense in depth drops any string value that looks like a URL, so a future SDK property that
 * carries the page address is still stripped.
 */

/** Exact SDK property names that carry location, referrer, device geometry or document titles. */
export const strippedPropertyNames: ReadonlySet<string> = new Set([
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
  "$title",
  "title",
  "$el_text",
  "$elements",
  "$elements_chain",
  "$external_click_url",
  "$prev_pageview_pathname",
  "$lib_custom_api_host",
]);

/**
 * Property name prefixes for SDK referrer keywords, session-entry, initial-visit, previous-pageview
 * and campaign data.
 */
export const strippedPropertyPrefixes: readonly string[] = [
  // posthog-js stores the referring search engine's query as `ph_keyword`.
  "ph_",
  "$session_entry_",
  "$initial_",
  "$prev_pageview_",
  "utm_",
  "$utm_",
];

/** Click identifiers added by ad platforms, which PostHog records as campaign properties. */
export const clickIdPropertyNames: ReadonlySet<string> = new Set([
  "gclid",
  "gclsrc",
  "gad_source",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "igshid",
  "ttclid",
  "rdt_cid",
  "epik",
  "qclid",
  "sccid",
  "irclid",
  "_kx",
  "mc_cid",
]);

const urlLike = /[a-z][a-z0-9+.-]*:\/\//i;

export function isStrippedProperty(name: string): boolean {
  return (
    strippedPropertyNames.has(name) ||
    clickIdPropertyNames.has(name) ||
    strippedPropertyPrefixes.some((prefix) => name.startsWith(prefix))
  );
}

/** Removes stripped keys and URL-like string values from a property bag in place. */
export function scrubProperties(bag: Record<string, unknown> | undefined | null): void {
  if (!bag) return;
  for (const [name, value] of Object.entries(bag)) {
    if (isStrippedProperty(name) || (typeof value === "string" && urlLike.test(value))) {
      delete bag[name];
    }
  }
}

/** The event shape both PostHog SDKs pass to `before_send`. */
export interface ScrubbableEvent {
  event: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

/** Scrubs `properties`, `$set` and `$set_once` (including the copies nested in `properties`). */
export function scrubEvent<Event extends ScrubbableEvent>(event: Event): Event {
  scrubProperties(event.properties);
  scrubProperties(event.$set);
  scrubProperties(event.$set_once);
  const nested = event.properties;
  if (nested) {
    for (const key of ["$set", "$set_once"] as const) {
      const bag = nested[key];
      if (typeof bag === "object" && bag !== null && !Array.isArray(bag)) {
        scrubProperties(bag as Record<string, unknown>);
      }
    }
  }
  return event;
}
