// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.symplist.example/tasks/0192f0a0-0000-7000-8000-000000000101?email=maya%40example.com&utm_source=newsletter&utm_campaign=beta&gclid=fictional-click","referrer":"https://www.google.com/search?q=refresh+my+portfolio"}
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserAnalytics, type PostHogBrowserClient } from "./browser.ts";
import { createPostHogConfig } from "./config.ts";
import { isStrippedProperty } from "./scrub.ts";

/**
 * The PostHog jsdom payload test (§15, §17): posthog-js 1.433.4 runs in jsdom on a page whose URL
 * carries an email, UTM parameters and a click id, reached from a search engine. Nothing may touch
 * storage or the network before consent, and after consent no URL, referrer, campaign or search
 * keyword may appear in any payload.
 */

interface CapturedRequest {
  readonly transport: "fetch" | "xhr" | "beacon";
  readonly url: string;
  readonly body: string;
}

interface SentEvent {
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly $set?: Record<string, unknown>;
  readonly $set_once?: Record<string, unknown>;
}

const projectKey = "phc_fictional_jsdom_key";
const analyticsId = "0192f0a0-0000-7000-8000-00000000a11d";

const requests: CapturedRequest[] = [];
const pendingBodies: Promise<void>[] = [];
let loads = 0;

/** Strings from the page address, referrer and campaign that must never leave the page. */
const forbiddenFragments = [
  "app.symplist.example",
  "/tasks/",
  "0192f0a0-0000-7000-8000-000000000101",
  "maya",
  "example.com",
  "utm_",
  "newsletter",
  "gclid",
  "fictional-click",
  "google",
  "refresh my portfolio",
  "refresh+my+portfolio",
];

async function bodyText(body: unknown): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  let bytes: Uint8Array;
  if (body instanceof Blob) bytes = new Uint8Array(await body.arrayBuffer());
  else if (Object.prototype.toString.call(body) === "[object ArrayBuffer]") {
    bytes = new Uint8Array(body as ArrayBuffer);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else {
    return String(body);
  }
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return gzipped ? gunzipSync(bytes).toString("utf8") : new TextDecoder().decode(bytes);
}

async function flushPostHog(): Promise<void> {
  // posthog-js drains its queue with sendBeacon when the page hides.
  window.dispatchEvent(new Event("pagehide"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.all(pendingBodies.splice(0));
}

function sentEvents(): SentEvent[] {
  return requests.flatMap((request) => {
    if (request.body === "") return [];
    const parsed = JSON.parse(request.body) as { batch?: SentEvent[] } | SentEvent;
    return "batch" in parsed && Array.isArray(parsed.batch) ? parsed.batch : [parsed as SentEvent];
  });
}

function storageKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "");
}

async function loadPostHog(): Promise<PostHogBrowserClient> {
  loads += 1;
  return (await import("posthog-js")).posthog;
}

beforeAll(() => {
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ transport: "fetch", url: String(input), body: await bodyText(init?.body) });
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  });
  vi.stubGlobal("fetch", fakeFetch);
  window.fetch = fakeFetch as typeof window.fetch;
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function recordXhr(body) {
    requests.push({ transport: "xhr", url: "xhr", body: String(body ?? "") });
  });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body?: BodyInit | null) => {
      pendingBodies.push(
        bodyText(body).then((text) => {
          requests.push({ transport: "beacon", url, body: text });
        }),
      );
      return true;
    },
  });
});

beforeEach(() => {
  requests.length = 0;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("posthog-js in jsdom (§15)", () => {
  it("before consent: never loads the SDK, touches no storage or cookies and makes no requests", async () => {
    const analytics = createBrowserAnalytics({ enabled: true, projectKey, loadPostHog });

    expect(await analytics.applyConsent({ consent: "unset", analyticsId })).toEqual({
      status: "inactive",
      reason: "consent_not_granted",
    });
    expect(await analytics.applyConsent({ consent: "denied", analyticsId })).toEqual({
      status: "inactive",
      reason: "consent_not_granted",
    });
    expect(
      analytics.track("search_used", {
        surface: "full_search",
        include_archive: false,
        include_chat: false,
        result_count: "1-5",
      }),
    ).toEqual({ status: "refused", reason: "consent_not_granted" });
    await flushPostHog();

    expect(loads).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  it("even when initialized with the Symplist config, posthog-js stores and sends nothing until opt-in", async () => {
    const posthog = await loadPostHog();
    posthog.init(projectKey, createPostHogConfig());
    posthog.capture("search_used", {
      surface: "full_search",
      include_archive: false,
      include_chat: false,
      result_count: "0",
    });
    await flushPostHog();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  it("after consent: sends only allowlisted events with no URL, referrer, campaign or keyword data", async () => {
    const analytics = createBrowserAnalytics({ enabled: true, projectKey, loadPostHog });
    expect(await analytics.applyConsent({ consent: "granted", analyticsId })).toEqual({
      status: "active",
    });

    expect(
      analytics.track("search_used", {
        surface: "full_search",
        include_archive: false,
        include_chat: false,
        result_count: "1-5",
      }),
    ).toEqual({ status: "sent" });
    expect(
      analytics.track("appearance_changed", {
        changed: "theme",
        theme: "paper",
        accent: "custom",
        mode: "dark",
      }),
    ).toEqual({ status: "sent" });

    // Bypassing the wrapper still cannot send anything outside the client allowlist.
    const posthog = await loadPostHog();
    posthog.capture("$pageview");
    posthog.capture("task_created", { source: "user", collection: "now", is_subtask: false });
    posthog.capture("quick_chat_started", { entry: "button", query: "free text" });
    posthog.capture("document_opened", { section: "Projects to feature" });
    await flushPostHog();

    const events = sentEvents();
    expect(events.map((event) => event.event).sort()).toEqual([
      "$identify",
      "appearance_changed",
      "search_used",
    ]);

    for (const request of requests) {
      expect(new URL(request.url).origin).toBe("https://us.i.posthog.com");
      for (const fragment of forbiddenFragments) {
        expect(request.url.toLowerCase()).not.toContain(fragment);
      }
    }
    for (const event of events) {
      const serialized = JSON.stringify(event).toLowerCase();
      for (const fragment of forbiddenFragments) {
        expect(serialized, `${event.event} carries ${fragment}`).not.toContain(fragment);
      }
      for (const bag of [event.properties, event.$set ?? {}, event.$set_once ?? {}]) {
        for (const [name, value] of Object.entries(bag)) {
          expect(isStrippedProperty(name), `${event.event}.${name}`).toBe(false);
          if (typeof value === "string") expect(value).not.toMatch(/:\/\//);
        }
      }
    }

    const search = events.find((event) => event.event === "search_used");
    expect(search?.properties).toMatchObject({
      surface: "full_search",
      include_archive: false,
      include_chat: false,
      result_count: "1-5",
      event_version: 1,
      distinct_id: analyticsId,
    });
    expect(document.cookie).toBe("");
  });

  it("logout clears the stored identity so the next account on the device starts clean", async () => {
    const analytics = createBrowserAnalytics({ enabled: true, projectKey, loadPostHog });
    await analytics.applyConsent({ consent: "granted", analyticsId });
    await flushPostHog();
    expect(localStorage.getItem(`ph_${projectKey}_posthog`)).toContain(analyticsId);

    await analytics.logout();

    const leftovers = [...storageKeys(localStorage), ...storageKeys(sessionStorage)].filter(
      (key) => key.startsWith("ph_") || key.startsWith("__ph_opt_in_out_"),
    );
    expect(leftovers).toEqual([]);

    // A later page load for a signed-out visitor, or a denial from another device, finds nothing.
    const nextPage = createBrowserAnalytics({ enabled: true, projectKey, loadPostHog });
    localStorage.setItem(`ph_${projectKey}_posthog`, JSON.stringify({ distinct_id: analyticsId }));
    const loadsBefore = loads;
    await nextPage.applyConsent({ consent: "denied", analyticsId });
    expect(loads).toBe(loadsBefore);
    expect(localStorage.getItem(`ph_${projectKey}_posthog`)).toBeNull();
    requests.length = 0;
  });

  it("withdrawal opts out, resets, clears ph_* storage and sends nothing afterwards", async () => {
    const analytics = createBrowserAnalytics({ enabled: true, projectKey, loadPostHog });
    await analytics.applyConsent({ consent: "granted", analyticsId });
    expect(
      analytics.track("appearance_changed", {
        changed: "mode",
        theme: "studio",
        accent: "preset",
        mode: "system",
      }),
    ).toEqual({ status: "sent" });
    await flushPostHog();
    expect(storageKeys(localStorage).some((key) => key.startsWith("ph_"))).toBe(true);
    requests.length = 0;

    await analytics.withdraw();

    const leftovers = [...storageKeys(localStorage), ...storageKeys(sessionStorage)].filter(
      (key) => key.startsWith("ph_") || key.startsWith("__ph_opt_in_out_"),
    );
    expect(leftovers).toEqual([]);
    expect(document.cookie).toBe("");

    expect(analytics.track("quick_chat_started", { entry: "shortcut" })).toEqual({
      status: "refused",
      reason: "consent_not_granted",
    });
    const posthog = await loadPostHog();
    posthog.capture("quick_chat_started", { entry: "shortcut" });
    await flushPostHog();
    expect(requests).toEqual([]);
  });
});
