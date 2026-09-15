import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import { clientBeforeSend, createPostHogConfig } from "./config.ts";

function capture(event: string, properties: Record<string, unknown>): CaptureResult {
  return { uuid: "01a0a5c1-3ac9-7f71-8b80-33a11925ca29", event, properties };
}

describe("posthog-js configuration (§15, research C1)", () => {
  it("is exactly the locked-down configuration", () => {
    const { before_send, ...config } = createPostHogConfig();
    expect(before_send).toBe(clientBeforeSend);
    expect(config).toEqual({
      api_host: "https://us.i.posthog.com",
      ui_host: "https://us.posthog.com",
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
    });
  });

  it("turns off every capture_* option, autocapture and rageclick", () => {
    const config = createPostHogConfig() as Record<string, unknown>;
    const automatic = Object.keys(config).filter(
      (key) => key.startsWith("capture_") || key === "autocapture" || key === "rageclick",
    );
    expect(automatic.length).toBeGreaterThanOrEqual(8);
    for (const key of automatic) expect(config[key], key).toBe(false);
  });

  it("accepts an https ingestion origin and refuses anything else", () => {
    expect(createPostHogConfig({ apiHost: "https://ph.symplist.example" }).api_host).toBe(
      "https://ph.symplist.example",
    );
    expect(() => createPostHogConfig({ apiHost: "http://ph.symplist.example" })).toThrow();
    expect(() => createPostHogConfig({ apiHost: "https://ph.symplist.example/ingest" })).toThrow();
  });
});

describe("client before_send", () => {
  it("passes allowlisted client events with valid properties, scrubbed", () => {
    const result = clientBeforeSend(
      capture("quick_chat_started", {
        entry: "button",
        event_version: 1,
        token: "phc_fictional",
        distinct_id: "a1",
        $current_url: "https://app.symplist.example/now",
        ph_keyword: "portfolio",
        $browser: "Safari",
      }),
    );
    expect(result?.properties).toEqual({
      entry: "button",
      event_version: 1,
      token: "phc_fictional",
      distinct_id: "a1",
      $browser: "Safari",
    });
  });

  it("passes $identify with scrubbed person properties", () => {
    const result = clientBeforeSend({
      ...capture("$identify", { distinct_id: "a1", $referrer: "https://www.google.com/" }),
      $set_once: {
        $initial_current_url: "https://app.symplist.example/",
        $initial_browser: "Safari",
      },
    });
    expect(result?.properties).toEqual({ distinct_id: "a1" });
    expect(result?.$set_once).toEqual({});
  });

  it("removes application properties from $identify instead of letting them through", () => {
    const result = clientBeforeSend(
      capture("$identify", {
        distinct_id: "a1",
        token: "phc_fictional",
        $anon_distinct_id: "anon",
        workspace: "Maya",
        event_version: 1,
      }),
    );
    expect(result?.properties).toEqual({
      distinct_id: "a1",
      token: "phc_fictional",
      $anon_distinct_id: "anon",
    });
  });

  it.each([
    ["null", null],
    ["$pageview", capture("$pageview", {})],
    ["$autocapture", capture("$autocapture", {})],
    ["$exception", capture("$exception", {})],
    ["$opt_in", capture("$opt_in", {})],
    ["an unknown event", capture("document_opened", { event_version: 1 })],
    [
      "a server-owned event",
      capture("task_created", {
        source: "user",
        collection: "now",
        is_subtask: false,
        event_version: 1,
      }),
    ],
    [
      "free text added to an allowlisted event",
      capture("quick_chat_started", {
        entry: "button",
        event_version: 1,
        prompt: "Plan a quiet weekend",
      }),
    ],
    ["a missing event_version", capture("quick_chat_started", { entry: "button" })],
    ["a wrong event_version", capture("quick_chat_started", { entry: "button", event_version: 2 })],
    [
      "a registered super property",
      capture("quick_chat_started", { entry: "button", event_version: 1, workspace: "Maya" }),
    ],
  ])("drops %s", (_label, event) => {
    expect(clientBeforeSend(event)).toBeNull();
  });
});
