import { afterEach, describe, expect, it, vi } from "vitest";
import { isMailbox, parseOrigin, posthogProjectKeyPattern } from "./fields.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("origins", () => {
  it.each([
    ["http://localhost:3000", "http"],
    ["https://api.symplist.example.com", "http"],
    ["http://[::1]:4000", "http"],
    ["ws://localhost:4000", "ws"],
    ["wss://api.symplist.example.com", "ws"],
    ["wss://api.symplist.example.com:8443", "ws"],
  ] as const)("accepts the canonical origin %s", (value, kind) => {
    expect(parseOrigin(value, kind)?.host).toBeTruthy();
  });

  it.each([
    ["http://localhost:3000/", "http"],
    ["https://api.example.com/v1", "http"],
    ["https://api.example.com?x=1", "http"],
    ["https://api.example.com#top", "http"],
    ["https://api.example.com:443", "http"],
    ["wss://api.example.com:443", "ws"],
    ["HTTPS://API.EXAMPLE.COM", "http"],
    ["https://user:pass@api.example.com", "http"],
    ["https://api.example.com", "ws"],
    ["wss://api.example.com", "http"],
    ["ftp://api.example.com", "http"],
    ["api.example.com", "http"],
    [" https://api.example.com", "http"],
  ] as const)("rejects %j as a %s origin", (value, kind) => {
    expect(parseOrigin(value, kind)).toBeNull();
  });

  it("does not depend on URL.origin, which some browser engines serialize as null for ws URLs", () => {
    vi.spyOn(URL.prototype, "origin", "get").mockReturnValue("null");
    expect(parseOrigin("wss://api.symplist.example.com", "ws")).not.toBeNull();
    expect(parseOrigin("ws://localhost:4000", "ws")).not.toBeNull();
    expect(parseOrigin("https://api.symplist.example.com", "http")).not.toBeNull();
    expect(parseOrigin("wss://api.symplist.example.com/v1/ws", "ws")).toBeNull();
  });
});

describe("sender mailboxes", () => {
  it.each([
    "security@example.com",
    "Symplist <security@example.com>",
    "Symplist Inc. <security@example.com>",
    "Tejas's Symplist <reminders@example.com>",
  ])("accepts %j", (value) => {
    expect(isMailbox(value)).toBe(true);
  });

  it.each([
    "Symplist, Inc. <security@example.com>",
    "Symplist; <security@example.com>",
    "a@b <security@example.com>",
    "Symplist (security) <security@example.com>",
    'Sym"plist <security@example.com>',
    "Symplist\t<security@example.com>",
    "Symplist <security@example.com>\r\nBcc: someone@example.com",
    " Symplist <security@example.com>",
    "Symplist <security@example.com",
    "Symplist <not an address>",
  ])("rejects %j", (value) => {
    expect(isMailbox(value)).toBe(false);
  });
});

describe("PostHog project keys", () => {
  it("accepts project ingest keys and refuses personal API keys", () => {
    expect(posthogProjectKeyPattern.test(`phc_${"a1B2".repeat(10)}`)).toBe(true);
    expect(posthogProjectKeyPattern.test(`phx_${"a1B2".repeat(10)}`)).toBe(false);
    expect(posthogProjectKeyPattern.test("phc_short")).toBe(false);
  });
});
