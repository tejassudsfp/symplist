# D2 Simon Connections and Vault integration

Status: **implemented and locally verified; live Composio/Trigger and browser verification remain**.

This closes the root-owned seam left by the merged Simon, Connections and Vault streams. The same
Symplist-owned tool surface is now registered in the local Nest executor and the durable
`simon-run` Trigger task: `search_tools`, `get_tool_schemas`, native `manage_connections` and
`execute_tools`. Trigger Sessions/chat-agent transports remain deliberately absent; durable content
continues through encrypted D1 state and the encrypted worker-to-API output path.

## Security and execution boundary

- A fresh claimed-run authority supplies only the owner's active native connection records and
  rechecks admission, account-key presence, task activity, cancellation and executor generation.
  The wrapper selects the exact native connection and injects its confirmed upstream account id;
  model-supplied identity/session selectors are removed recursively.
- Provider workbench, bash, multi-execute, connection-management and all other `COMPOSIO_*` actions
  are unavailable to the model. `manage_connections` reads native Symplist state and returns only
  native ids plus the fixed Settings path.
- The deterministic reviewed policy owns approvals. A batch containing an approval-requiring
  action must contain exactly one action. Edited arguments are validated in the API by an
  owner-bound metadata-only factory and always create a fresh proposal/digest; the durable API does
  not import the agent/model runtime.
- Approved effects are wired through the existing invocation ledger in both executors. Side effects
  use the raw SDK client with `maxRetries: 0`; ambiguous provider outcomes become `uncertain` and
  cannot be resent by a retry or process restart.
- Vault handles are accepted only as exact review placeholders. The session and live tool metadata
  are prepared first, then the executor resolves a grant against the claimed run immediately before
  local plaintext schema validation and the final authority-fenced provider call. Quick chat rejects
  handles. Provider results cross the mandatory redactor before any checkpoint, model or output
  sink; provider exceptions are reduced to stable codes/details.

The final adversarial pass removed an extra D1 authority round trip that had occurred after Vault
decryption, shrinking the plaintext lifetime to local validation plus the single final authority
check/provider call. It also fixed provider-specific `Retry-After` propagation through Simon's
approval-edit HTTP error boundary. A first integration draft imported the Connections Nest module;
the review caught that §2.3 violation and replaced it with this Simon-owned adapter over shared
core/integrations services. A structural regression test now forbids that feature-module coupling.

## Verification

- `packages/agent/src/connections.test.ts`: identical local/Trigger journeys for native connection
  status, provider failure normalization, discovery/schema/proposal/continuation, exact account and
  raw no-retry execution, uncertain timeouts, revoked/expired/foreign/quick-chat Vault rejection,
  encrypted persistence and plaintext/base64/base64url/URL-form redaction.
- `packages/integrations/src/execution.test.ts`: discovery allowlisting, forbidden meta/sandbox
  actions, schema and exact-account validation, immutable resolved actions, handle-shape validation,
  no D1/provider operation between resolution and final execution, generation/admission fencing,
  no-retry ambiguous writes and bounded content-free errors.
- `packages/core/src/connections/authority.test.ts`: owner and executor-generation authority under
  local and durable claims plus owner-only metadata authority after relock.
- API boundary tests prove durable mode installs no local model/tool handler, local Simon contains no
  Trigger call, and the Connections runtime statically imports only the pure agent policy subpath.
  Worker registration proves the durable task receives both the wrapper tools and approved effect.

All **17 project typechecks passed** (run directly with the installed TypeScript 7 binary), and
Biome checked **1,410 files** with zero errors or warnings. The production TypeScript build,
documentation/44-screen check and whitespace check passed. Affected full suites pass:
integrations **21/21**, agent **107/107**, core **777/777** and worker **100/100**. The first
parallel core/worker run hit three unrelated five-second Git/source-scan timeouts; each complete
suite passed when rerun serially, without changing a timeout.

Eight focused pure API tests pass. A Simon HTTP test initialized the complete Nest dependency graph
and then hit the workspace sandbox's expected `listen EPERM 0.0.0.0`; no assertion or dependency
injection failed before the socket bind. The exact pnpm 12.4.2 recursive runner attempted to relink
the copied worktree dependencies and could not reach the registry from this sandbox, so frozen
install/full HTTP/e2e/live-provider gates remain for the integrated checkout. No live credential
was printed, copied or written to a tracked file.

## Shared-file inventory

Outside the owned agent/integrations/core Connections and Vault seams, this stream changes:

```text
apps/api/src/common/errors/api-error.ts
apps/api/src/common/errors/exception.filter.test.ts
apps/api/src/modules/simon/simon.connections.ts
apps/api/src/modules/simon/simon.executor-boundary.test.ts
apps/api/src/modules/simon/simon.http.ts
apps/api/src/modules/simon/simon.local.ts
apps/api/src/modules/simon/simon.module.ts
apps/worker/src/infra/simon-connections-registration.test.ts
apps/worker/src/trigger/simon/simon-run.ts
docs/build/coverage.md
docs/build/decisions.md
docs/build/reports/d2-simon-connections.md
packages/agent/src/index.ts
packages/agent/src/turn.ts
```
