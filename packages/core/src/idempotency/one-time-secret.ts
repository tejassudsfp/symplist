import { secretAlreadyIssuedNotice } from "@symplist/contracts";

/** A one-time secret response violated the minting contract (§6.1, decision C1.3). */
export class OneTimeSecretResponseError extends Error {
  readonly code = "idempotency.one_time_secret_invalid";
  constructor(rule: string) {
    super(`One-time secret response ${rule}`);
    this.name = "OneTimeSecretResponseError";
  }
}

/** Secret strings shorter than this are too short to scan for without false positives. */
const minScannedSecretLength = 8;

function secretStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (value.length >= minScannedSecretLength) into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) secretStrings(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) secretStrings(item, into);
  }
}

/**
 * The redacted outcome recorded for an endpoint that mints a one-time secret (§6.1, decision R11):
 * the minting response without its secret fields, with `secretUnavailable: true` and
 * `notice: "secret.already_issued"`. This is what an exact retry receives and the only form ever
 * written to `idempotency_records`.
 *
 * Throws when the minting response is not a `secretUnavailable: false` object carrying every secret
 * field, or when a secret value also appears inside a non-secret field, so a mistake in an endpoint
 * fails the request instead of persisting the secret.
 */
export function redactOneTimeSecretResponse(
  body: unknown,
  secretKeys: readonly string[],
): Record<string, unknown> {
  if (secretKeys.length === 0) throw new OneTimeSecretResponseError("declares no secret fields");
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OneTimeSecretResponseError("is not an object");
  }
  const record = body as Record<string, unknown>;
  if (record.secretUnavailable !== false) {
    throw new OneTimeSecretResponseError("must carry secretUnavailable: false when minting");
  }
  const secrets: string[] = [];
  for (const key of secretKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new OneTimeSecretResponseError(`is missing its secret field ${key}`);
    }
    secretStrings(record[key], secrets);
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (secretKeys.includes(key) || key === "secretUnavailable" || key === "notice") continue;
    redacted[key] = value;
  }
  const serialized = JSON.stringify(redacted);
  const leaked = secrets.some(
    (secret) =>
      serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1)),
  );
  if (leaked) {
    throw new OneTimeSecretResponseError("repeats a secret value in a non-secret field");
  }
  return { ...redacted, secretUnavailable: true, notice: secretAlreadyIssuedNotice };
}
