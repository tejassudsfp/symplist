import type { McpScope } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { AccessPolicy } from "../access/evaluate.ts";

export interface McpIdentity {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: "api_key" | "oauth";
  readonly clientId: string | null;
  readonly scopes: readonly McpScope[];
  readonly taskIds: readonly string[] | null;
  readonly generation: number;
  readonly expiresAt: number;
}
export interface McpOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly now: () => number;
  readonly policy: AccessPolicy;
}
export class McpError extends Error {
  constructor(
    readonly code:
      | "mcp.invalid_token"
      | "mcp.invalid_request"
      | "mcp.not_found"
      | "mcp.forbidden"
      | "mcp.conflict",
  ) {
    super(code);
  }
}
export function mcpField(
  ownerId: string,
  table: "mcp_grants" | "oauth_requests",
  rowId: string,
  column: "client_name_enc" | "state_enc",
) {
  return {
    ownerId,
    table,
    rowId,
    column,
    purpose: column === "client_name_enc" ? "mcp_client_name" : "oauth_state",
  };
}
