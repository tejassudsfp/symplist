import { INTERNAL_CONTENT_TYPE } from "@symplist/core/events";
import { type KeyProvider, signInternalRequest } from "@symplist/crypto";
import { uuidv7 } from "@symplist/db";
import type { WorkerTimers } from "./timers.ts";

/** The subset of `fetch` the worker clients use. */
export type WorkerFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SignedApiRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly eventId: string;
}

/** Builds a signed `POST` to an internal api path (§6.2) over the exact body bytes. */
export function signedApiRequest(input: {
  readonly apiOrigin: string;
  readonly path: string;
  readonly body: Uint8Array;
  readonly keys: KeyProvider;
  readonly timers: WorkerTimers;
  readonly eventId?: string;
}): SignedApiRequest {
  const eventId = input.eventId ?? uuidv7(input.timers.now());
  const headers = signInternalRequest(input.keys, {
    timestamp: Math.floor(input.timers.now() / 1000),
    eventId,
    method: "POST",
    path: input.path,
    body: input.body,
  });
  return {
    url: `${input.apiOrigin}${input.path}`,
    eventId,
    init: {
      method: "POST",
      headers: { ...headers, "content-type": INTERNAL_CONTENT_TYPE },
      body: input.body as NonNullable<RequestInit["body"]>,
      redirect: "error",
    },
  };
}

export type DeliveryOutcome = "delivered" | "duplicate" | "rejected" | "retryable";

/** Sends one signed request with a timeout; never reads or returns the response body. */
export async function deliver(
  fetchImpl: WorkerFetch,
  request: SignedApiRequest,
  timers: WorkerTimers,
  timeoutMs: number,
): Promise<{ readonly outcome: DeliveryOutcome; readonly status: number | null }> {
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    if (status === 202 || status === 204) return { outcome: "delivered", status };
    if (status === 200) return { outcome: "duplicate", status };
    if (status === 408 || status === 429 || status >= 500) return { outcome: "retryable", status };
    return { outcome: "rejected", status };
  } catch {
    return { outcome: "retryable", status: null };
  } finally {
    timers.clearTimeout(timer);
  }
}
