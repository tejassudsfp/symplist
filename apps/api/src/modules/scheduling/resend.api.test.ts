import { createHmac, randomBytes } from "node:crypto";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function signed(secret: Buffer, id: string, body: unknown, ageSeconds = 0) {
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds);
  const signature = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${JSON.stringify(body)}`)
    .digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}
async function fixture() {
  const secret = randomBytes(32);
  const app = await bootTestApp({
    env: { RESEND_WEBHOOK_SECRET: `whsec_${secret.toString("base64")}` },
  });
  apps.push(app);
  return { app, secret };
}
const event = (type: string) => ({
  type,
  created_at: "2026-09-15T10:00:00Z",
  data: {
    email_id: "provider-example",
    to: ["receiver@example.test"],
    subject: "PRIVATE_RESEND_SUBJECT",
    html: "PRIVATE_RESEND_BODY",
    bounce: { type: "Permanent" },
  },
});

describe("raw-body Resend verification", () => {
  it.each([
    "email.delivered",
    "email.bounced",
    "email.complained",
    "email.failed",
    "email.suppressed",
    "email.delivery_delayed",
  ])(
    "accepts and atomically deduplicates %s without persisting provider plaintext",
    async (type) => {
      const { app, secret } = await fixture();
      const body = event(type);
      const headers = signed(secret, "msg_example", body);
      const first = await app.post("/webhooks/resend", { body, headers, origin: null });
      expect(first.status, first.text).toBe(200);
      expect((await app.post("/webhooks/resend", { body, headers, origin: null })).status).toBe(
        200,
      );
      expect(
        await app.db.first(
          sql("SELECT COUNT(*) AS n FROM webhook_receipts WHERE provider='resend'"),
        ),
      ).toEqual({ n: 1 });
      const count = await app.db.first(sql("SELECT COUNT(*) AS n FROM email_suppressions"));
      expect(count?.n).toBe(type === "email.bounced" || type === "email.complained" ? 1 : 0);
      const persisted = JSON.stringify(
        await app.db.all(sql("SELECT * FROM notification_provider_events")),
      );
      expect(persisted).not.toContain("PRIVATE_RESEND");
      expect(persisted).not.toContain("receiver");
      expect(app.logs.text()).not.toContain("PRIVATE_RESEND");
      expect(app.logs.events("email.delivery_tracking_disabled")).toHaveLength(0);
    },
  );
  it("rejects changed raw content, old signatures, missing headers and unlisted events with 400", async () => {
    const { app, secret } = await fixture();
    const body = event("email.delivered");
    for (const options of [
      {
        body: { ...body, data: { ...body.data, subject: "TAMPERED_MARKER" } },
        headers: signed(secret, "tampered", body),
      },
      { body, headers: signed(secret, "old", body, 600) },
      { body, headers: {} },
      { body: event("email.opened"), headers: signed(secret, "opened", event("email.opened")) },
    ])
      expect((await app.post("/webhooks/resend", options)).status).toBe(400);
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM webhook_receipts"))).toEqual({ n: 0 });
    expect(app.logs.text()).not.toContain("TAMPERED_MARKER");
    expect(app.logs.text()).not.toContain("PRIVATE_RESEND");
  });
});
