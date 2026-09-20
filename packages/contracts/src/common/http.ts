/**
 * HTTP header names shared by the web client and the api (the idempotency header lives in
 * `idempotency.ts`). Header names are case-insensitive on the wire; Node lowercases incoming names,
 * so servers read them with `.toLowerCase()`.
 */

/**
 * The CSRF header (§5.3): the session-bound token for the `app` class, or
 * `preSessionCsrfHeaderValue` for the `pre_session` class, where it forces a CORS preflight.
 */
export const csrfHeader = "X-Symplist-CSRF";

/** The fixed `X-Symplist-CSRF` value sent by `pre_session` routes (§5.3). */
export const preSessionCsrfHeaderValue = "1";

/** Seconds to wait before retrying; sent with `rate.limited` (§3.1, §4.3). */
export const retryAfterHeader = "Retry-After";

/** The api's request id, echoed as `error.requestId` in error envelopes (§6, §6.3). */
export const requestIdHeader = "X-Request-Id";
