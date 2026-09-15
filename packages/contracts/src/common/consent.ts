import { z } from "zod";
import { epochMillisSchema } from "./primitives.ts";

/**
 * Analytics consent on `users.analytics_consent` (§15, decision D5). Nothing loads or is stored
 * before `granted`; the banner shows while the state is `unset`.
 */
export const analyticsConsentStates = ["unset", "granted", "denied"] as const;
export const analyticsConsentStateSchema = z.enum(analyticsConsentStates);
export type AnalyticsConsentState = z.infer<typeof analyticsConsentStateSchema>;

/**
 * The stored consent with the time of the latest choice: `decidedAt` is null exactly when the state
 * is `unset`.
 */
export const analyticsConsentSchema = z
  .strictObject({
    state: analyticsConsentStateSchema,
    decidedAt: epochMillisSchema.nullable(),
  })
  .refine((consent) => (consent.state === "unset") === (consent.decidedAt === null), {
    error: "decidedAt is set exactly when a choice was made",
    path: ["decidedAt"],
  });

export type AnalyticsConsent = z.infer<typeof analyticsConsentSchema>;
