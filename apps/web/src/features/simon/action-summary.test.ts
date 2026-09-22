import { describe, expect, it } from "vitest";
import { actionLabel, actionSummary, serviceLabel } from "./action-summary.ts";

describe("Simon action summary", () => {
  it("reads a send as a sentence with the count of recipients", () => {
    expect(
      actionSummary({
        toolSlug: "GMAIL_SEND_EMAIL",
        connectionToolkit: "gmail",
        arguments: {
          recipient: ["first@example.test", "second@example.test"],
          subject: "Reviewed launch outline",
        },
      }),
    ).toEqual({ headline: "Send an email to 2 recipients", subject: "“Reviewed launch outline”" });
  });

  it("names a single recipient the arguments already carry", () => {
    expect(
      actionSummary({
        toolSlug: "GMAIL_SEND_EMAIL",
        connectionToolkit: "gmail",
        arguments: { recipient: "friend@example.test" },
      }).headline,
    ).toBe("Send an email to friend@example.test");
  });

  it("reads a read-only action as a search of the named service", () => {
    expect(
      actionSummary({
        toolSlug: "GMAIL_FETCH_EMAILS",
        connectionToolkit: "gmail",
        arguments: { query: "after:2026/09/17", max_results: 100 },
      }),
    ).toEqual({ headline: "Search your Gmail", subject: null });
  });

  it("dates a calendar action from the argument that carries the day", () => {
    const summary = actionSummary({
      toolSlug: "GOOGLECALENDAR_CREATE_EVENT",
      connectionToolkit: "googlecalendar",
      arguments: { summary: "Launch review", start_date: "2026-10-03" },
    });
    expect(summary.headline).toMatch(/^Create a calendar event on (?:3 October|October 3)/);
    expect(summary.subject).toBe("“Launch review”");
  });

  it("survives a verbose provider slug", () => {
    expect(
      actionSummary({
        toolSlug: "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
        connectionToolkit: "slack",
        arguments: { channel: "C0123456789" },
      }).headline,
    ).toBe("Send a Slack message");
  });

  it("counts a vault-held field without reading the handle", () => {
    const summary = actionSummary({
      toolSlug: "GMAIL_SEND_EMAIL",
      connectionToolkit: "gmail",
      arguments: { recipient: { $vault: "vgh_never_rendered" }, subject: "Quarterly report" },
    });
    expect(summary.headline).toBe("Send an email to 1 recipient");
    expect(JSON.stringify(summary)).not.toContain("vgh_never_rendered");
  });

  it("falls back to the humanised slug for a verb it cannot read", () => {
    expect(
      actionSummary({
        toolSlug: "GITHUB_APPROVE_PULL_REQUEST",
        connectionToolkit: "github",
        arguments: {},
      }).headline,
    ).toBe("Approve pull request");
  });

  it("stays plain when the approval names no toolkit", () => {
    expect(
      actionSummary({ toolSlug: "SEARCH_RECORDS", connectionToolkit: null, arguments: {} })
        .headline,
    ).toBe("Search the connected service");
  });

  it("keeps the service and action labels the owner already recognizes", () => {
    expect(serviceLabel("googlecalendar")).toBe("Google Calendar");
    expect(serviceLabel("hackernews")).toBe("Hacker News");
    expect(serviceLabel(null)).toBe("Connected service");
    expect(actionLabel("GMAIL_SEND_EMAIL", "gmail")).toBe("Send email");
  });
});
