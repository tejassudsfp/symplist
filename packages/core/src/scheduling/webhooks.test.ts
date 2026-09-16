import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { ResendDeliveryEvents, resendReminderEvents } from "./webhooks.ts";

describe("Resend delivery ledger", () => {
  let env: DocumentsTestEnvironment;
  let events: ResendDeliveryEvents;
  beforeEach(async () => {
    env = await createDocumentsTestEnvironment();
    events = new ResendDeliveryEvents(env.db, env.keys, () => env.clock);
  });
  afterEach(async () => env.close());
  const event = (type: string, createdAt = "2026-09-15T09:00:00Z", bounceType?: string) => ({
    type,
    created_at: createdAt,
    data: {
      email_id: "provider-one",
      to: ["maya@example.test"],
      subject: "PRIVATE_WEBHOOK_SUBJECT",
      ...(bounceType ? { bounce: { type: bounceType, message: "PRIVATE_BOUNCE" } } : {}),
    },
  });
  it.each(resendReminderEvents)(
    "records allowed %s without plaintext provider content",
    async (type) => {
      await events.apply("msg_one", event(type));
      expect(await env.count("webhook_receipts")).toBe(1);
      expect(await env.count("notification_provider_events")).toBe(1);
      const rows = await env.db.all(sql("SELECT * FROM notification_provider_events"));
      expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    },
  );
  it("deduplicates by svix-id, updates by event time and ignores out-of-order delivery", async () => {
    await events.apply("msg_one", event("email.delivered"));
    await events.apply("msg_two", event("email.bounced", "2026-09-15T10:00:00Z", "Permanent"));
    await events.apply("msg_one", event("email.delivered", "2026-09-16T10:00:00Z"));
    await events.apply("msg_three", event("email.delivery_delayed", "2026-09-15T08:00:00Z"));
    expect(
      (await env.db.first(sql("SELECT status FROM notification_provider_events")))?.status,
    ).toBe("bounced");
    expect(await env.count("webhook_receipts")).toBe(3);
    expect(await env.count("email_suppressions")).toBe(1);
  });
  it("suppresses only a permanent bounce or complaint, with a rotated-key digest", async () => {
    await events.apply("msg_soft", event("email.bounced", undefined, "Temporary"));
    await events.apply("msg_failed", event("email.failed"));
    await events.apply("msg_suppressed", event("email.suppressed"));
    expect(await env.count("email_suppressions")).toBe(0);
    await events.apply("msg_complaint", event("email.complained"));
    expect(await env.count("email_suppressions")).toBe(1);
    expect(JSON.stringify(await env.db.all(sql("SELECT * FROM email_suppressions")))).not.toContain(
      "maya",
    );
  });
  it.each(["email.sent", "email.opened", "email.clicked", "email.received"])(
    "rejects unsupported %s before recording a receipt",
    async (type) => {
      await expect(events.apply("msg_bad", event(type))).rejects.toThrow();
      expect(await env.count("webhook_receipts")).toBe(0);
    },
  );
  it("receipt and effect roll back together if the effect fails", async () => {
    await env.db.run(
      sql(
        "CREATE TRIGGER reject_provider_event BEFORE INSERT ON notification_provider_events BEGIN SELECT RAISE(ABORT,'rejected'); END",
      ),
    );
    await expect(events.apply("msg_retry", event("email.delivered"))).rejects.toThrow();
    expect(await env.count("webhook_receipts")).toBe(0);
  });
});
