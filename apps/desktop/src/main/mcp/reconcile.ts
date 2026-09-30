/**
 * Pure reconciliation of the device's grant against what the cloud says about it.
 *
 * The desktop refreshes `GET /v1/mcp/grants` on window focus, mirroring the `visibilitychange` refresh
 * `apps/web/src/features/connections/agent-connections.tsx` already does, so a revoke performed in the web
 * UI appears in the app within a second instead of waiting for the agent's next tool call.
 *
 * Be honest about what that is worth: between a revoke in the browser and the next focus or tool call, the
 * app still believes it has access. Generation fencing means nothing actually gets through in that window,
 * so this is a UI-truthfulness gap rather than a security one — and it must not be described as instant.
 *
 * The parsing is deliberately tolerant of fields it has never heard of. Validating the listing against
 * `mcpGrantViewSchema` would be stricter and worse: an installed app must keep working when the cloud adds
 * a field, and this only needs three of them.
 */

/** A grant row, narrowed to what a reconciliation decision depends on. */
export interface GrantRow {
  readonly id: string;
  readonly revokedAt: number | null;
  readonly expiresAt: number;
}

/** Reads the rows out of a `GET /v1/mcp/grants` body, skipping anything unrecognisable. */
export function parseGrantRows(body: string): GrantRow[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [];
  }
  const grants = (value as { grants?: unknown } | null)?.grants;
  if (!Array.isArray(grants)) return [];
  const rows: GrantRow[] = [];
  for (const entry of grants) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, revokedAt, expiresAt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof expiresAt !== "number") continue;
    rows.push({ id, revokedAt: typeof revokedAt === "number" ? revokedAt : null, expiresAt });
  }
  return rows;
}

/**
 * What the listing says about the grant this device holds.
 *
 * `missing` and `revoked` are separate answers even though both mean reconnect, because they are
 * different events: a grant that is gone from the listing belongs to another account or another install,
 * and one that is revoked was taken away on purpose. Only the log needs to tell them apart, but a caller
 * that cannot tell them apart cannot log them apart.
 */
export type GrantVerdict = "usable" | "missing" | "revoked" | "expired";

export function grantVerdict(
  grantId: string,
  rows: readonly GrantRow[],
  now: number,
): GrantVerdict {
  const row = rows.find((candidate) => candidate.id === grantId);
  if (!row) return "missing";
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt <= now) return "expired";
  return "usable";
}
