import { describe, expect, it } from "vitest";
import type { EmailMessage, EmailTransport } from "./index.ts";

describe("email transport interface", () => {
  it("carries html, text, sender kind and an idempotency key", async () => {
    const sent: EmailMessage[] = [];
    const transport: EmailTransport = {
      send: async (message) => {
        sent.push(message);
        return { providerId: null };
      },
    };
    await transport.send({
      to: "person@example.test",
      subject: "Subject",
      html: "<p>Body</p>",
      text: "Body",
      sender: "security",
      idempotencyKey: "test/1",
    });
    expect(sent).toHaveLength(1);
  });
});
