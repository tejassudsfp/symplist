import type { Composio } from "@composio/core";

export class ComposioWebhookError extends Error {
  constructor() {
    super("integration.webhook_invalid");
  }
}

export interface VerifiedConnectionWebhook {
  readonly receiptId: string;
  readonly event: "expired" | "ignored";
  readonly accountId: string | null;
}

/** Verify exact transport bytes with the installed SDK, then discard every content-bearing field. */
export async function verifyConnectionWebhook(
  client: Composio,
  secret: string,
  raw: Uint8Array,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Promise<VerifiedConnectionWebhook> {
  try {
    const receiptId = headers["webhook-id"];
    const timestamp = headers["webhook-timestamp"];
    const signature = headers["webhook-signature"];
    if (
      !secret ||
      typeof receiptId !== "string" ||
      !/^[A-Za-z0-9_-]{1,255}$/.test(receiptId) ||
      typeof timestamp !== "string" ||
      !/^\d{1,12}$/.test(timestamp) ||
      typeof signature !== "string" ||
      raw.byteLength === 0 ||
      raw.byteLength > 262_144
    )
      throw new ComposioWebhookError();
    const result = await client.triggers.parse(
      {
        body: raw,
        headers: {
          "webhook-id": receiptId,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
        },
      },
      { verifySecret: secret },
    );
    const event = result.rawPayload;
    if (
      result.version !== "V3" ||
      !("type" in event) ||
      event.type !== "composio.connected_account.expired"
    )
      return { receiptId, event: "ignored", accountId: null };
    const id: unknown = event.data.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
      throw new ComposioWebhookError();
    return { receiptId, event: "expired", accountId: id };
  } catch {
    throw new ComposioWebhookError();
  }
}
