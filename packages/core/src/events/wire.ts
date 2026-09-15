import { epochMillisSchema, idSchema, stableCodeSchema } from "@symplist/contracts";
import { z } from "zod";

/**
 * Wire formats of the signed worker-to-api requests (§6.2, §8.2), shared by the worker clients and
 * the api controllers. Bodies carry only ids, enums, counts, sequence numbers and encrypted
 * envelopes.
 */

/** `POST /internal/v1/events`. */
export const INTERNAL_EVENTS_PATH = "/internal/v1/events";

/** `POST /internal/v1/runs/:runId/output` for one run. */
export function runOutputPath(runId: string): string {
  return `/internal/v1/runs/${runId}/output`;
}

/**
 * The media type of internal request bodies. It is not `application/json`, so the api's global JSON
 * parser leaves the stream untouched and the controllers verify the signature over the exact bytes
 * with their own size limits.
 */
export const INTERNAL_CONTENT_TYPE = "application/vnd.symplist.internal+json";

/** Body size limits in bytes. A run output body holds one field envelope of at most 1 MiB plaintext. */
export const INTERNAL_BODY_LIMITS = Object.freeze({
  events: 64 * 1024,
  runOutput: 2 * 1024 * 1024,
});

/** An id, enum or opaque provider id inside an event payload. */
const tokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, { error: "Expected an id or enum" });

/** A `sym1` field envelope (§4.1): the only way content may travel between runtimes. */
export const fieldEnvelopeTextSchema = z
  .string()
  .max(1_500_000, { error: "Envelope is too large" })
  .regex(/^sym1\.[1-9][0-9]{0,8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/, {
    error: "Expected a sym1 field envelope",
  });

const payloadValueSchema = z.union([
  tokenSchema,
  fieldEnvelopeTextSchema.max(48_000, { error: "Event envelopes must be small" }),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
  z.null(),
  z.array(tokenSchema).max(100),
]);

/** An internal event payload: at most 32 camelCase keys of ids, enums, counts, flags or envelopes. */
export const internalEventPayloadSchema = z
  .record(z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/), payloadValueSchema)
  .refine((payload) => Object.keys(payload).length <= 32, { error: "Too many payload fields" });

export type InternalEventPayload = z.infer<typeof internalEventPayloadSchema>;

/** The body of `POST /internal/v1/events`; `id` must equal `X-Sym-Event-Id`. */
export const internalEventBodySchema = z.strictObject({
  id: idSchema,
  type: stableCodeSchema,
  ownerId: idSchema,
  occurredAt: epochMillisSchema,
  payload: internalEventPayloadSchema,
});

export type InternalEventBody = z.infer<typeof internalEventBodySchema>;

/** The body of `POST /internal/v1/runs/:runId/output` (§8.2). */
export const runOutputBodySchema = z.strictObject({
  runId: idSchema,
  /** The Trigger attempt number; `simon-run` has one attempt. */
  attempt: z.number().int().min(1).max(100),
  /** Monotonic per run; the api deduplicates on `(runId, seq)`. */
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  envelope: fieldEnvelopeTextSchema,
});

export type RunOutputBody = z.infer<typeof runOutputBodySchema>;

/**
 * One AI SDK UI message chunk as relayed on `conversation:<id>` (§7). Only the `type` discriminator is
 * checked here; the chunk itself is content and exists in plaintext only inside the envelope and the
 * api's memory.
 */
export const uiMessageChunkSchema = z.looseObject({
  type: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),
});

export type UiMessageChunk = z.infer<typeof uiMessageChunkSchema>;

/** The plaintext of one run output envelope: an ordered batch of UI chunks. */
export const runChunkBatchSchema = z.array(uiMessageChunkSchema).min(1).max(2_000);

/** The event type of relayed run output on a conversation topic (§7). */
export const RUN_CHUNK_EVENT_TYPE = "chunk";

/** The data of a relayed chunk event: the run it belongs to and the UI chunk. */
export interface RunChunkEventData {
  readonly runId: string;
  readonly chunk: UiMessageChunk;
}
