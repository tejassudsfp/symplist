import { z } from "zod";

/** The body of an API error response (§6). `details` never contains secrets or user content. */
export interface ErrorBody<Code extends string = string> {
  code: Code;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
}

/** Every API error is returned as `{ "error": { code, message, details?, requestId } }`. */
export interface ErrorEnvelope<Code extends string = string> {
  error: ErrorBody<Code>;
}

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().min(1),
  }),
});
