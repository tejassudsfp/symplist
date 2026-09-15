import { describe, expect, it } from "vitest";
import { isStrippedProperty, scrubEvent, scrubProperties } from "./scrub.ts";

describe("payload scrubber (§15)", () => {
  it("strips URL, path, referrer, host, campaign, click-id and keyword properties", () => {
    const event = {
      event: "$identify",
      properties: {
        $current_url: "https://app.symplist.example/tasks/1?email=maya%40example.com",
        $host: "app.symplist.example",
        $pathname: "/tasks/1",
        $referrer: "https://www.google.com/",
        $referring_domain: "www.google.com",
        $search_engine: "google",
        ph_keyword: "refresh my portfolio",
        $session_entry_url: "https://app.symplist.example/tasks/1",
        $session_entry_referrer: "https://www.google.com/",
        $initial_current_url: "https://app.symplist.example/",
        $prev_pageview_pathname: "/now",
        utm_source: "newsletter",
        $utm_campaign: "beta",
        gclid: "fictional",
        fbclid: "fictional",
        msclkid: "fictional",
        $screen_width: 1440,
        $viewport_height: 900,
        title: "Refresh my portfolio · symplist",
        $lib_custom_api_host: "https://proxy.symplist.example",
        $browser: "Safari",
        $lib: "web",
        token: "phc_fictional",
        distinct_id: "a1",
        future_url_property: "https://app.symplist.example/now",
        surface: "full_search",
        count: 3,
      },
      $set: { $current_url: "https://app.symplist.example/", $browser: "Safari" },
      $set_once: {
        $initial_referrer: "https://www.google.com/",
        $initial_utm_source: "newsletter",
        gclid: null,
        $initial_pathname: "/tasks/1",
      },
    };

    scrubEvent(event);

    expect(event.properties).toEqual({
      $browser: "Safari",
      $lib: "web",
      token: "phc_fictional",
      distinct_id: "a1",
      surface: "full_search",
      count: 3,
    });
    expect(event.$set).toEqual({ $browser: "Safari" });
    expect(event.$set_once).toEqual({});
  });

  it("scrubs $set and $set_once nested inside properties", () => {
    const event = {
      event: "$identify",
      properties: {
        $set: { $current_url: "https://app.symplist.example/", plan: "none" },
        $set_once: { $initial_referrer: "https://www.google.com/" },
      },
    };
    scrubEvent(event);
    expect(event.properties).toEqual({ $set: { plan: "none" }, $set_once: {} });
  });

  it("classifies property names", () => {
    expect(isStrippedProperty("$current_url")).toBe(true);
    expect(isStrippedProperty("$session_entry_host")).toBe(true);
    expect(isStrippedProperty("utm_term")).toBe(true);
    expect(isStrippedProperty("ttclid")).toBe(true);
    expect(isStrippedProperty("$browser")).toBe(false);
    expect(isStrippedProperty("event_version")).toBe(false);
  });

  it("tolerates missing bags", () => {
    expect(() => scrubProperties(undefined)).not.toThrow();
    expect(() => scrubProperties(null)).not.toThrow();
    expect(scrubEvent({ event: "x" })).toEqual({ event: "x" });
  });
});
