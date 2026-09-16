import { defineEvents } from "../common/ws.ts";
import { z } from "../common/zod.ts";

/** WebSocket events owned by the vault feature (§11, §7), keyed by event type. */
export const vaultEvents = defineEvents({
  "vault.locked": z.strictObject({
    reason: z.enum(["manual", "idle", "session", "reset", "restricted"]),
  }),
});
