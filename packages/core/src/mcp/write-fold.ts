import { IdempotencyStore } from "../idempotency/store.ts";
import type { TaskWriteFold } from "../tasks/service.ts";
import type { McpGrants } from "./grants.ts";
import { McpError, type McpIdentity } from "./types.ts";

/** A grant-bound encrypted idempotency fold supplied to an actual core deciding mutation. */
export function mcpWriteFold(
  grants: McpGrants,
  identity: McpIdentity,
  tool: string,
  requestId: string,
  input: unknown,
): TaskWriteFold {
  const store = new IdempotencyStore(grants.options);
  const request = {
    scope: `mcp:${identity.id}:${tool}`,
    userId: identity.ownerId,
    key: requestId,
    input,
    now: grants.options.now(),
  };
  const folded = store.foldedClaim(request);
  return {
    ...folded,
    completion: (response, accountKey) =>
      store.completeStatement({
        claim: folded.claim,
        response,
        accountKey,
        now: grants.options.now(),
      }),
    decide: (results, accountKey, offset) => {
      const result = store.decideFoldedClaim({ request, folded, results, accountKey, offset });
      if (result.kind === "replay") return { kind: "replay", body: result.response.body };
      if (result.kind !== "started") throw new McpError("mcp.conflict");
      return result;
    },
  };
}
