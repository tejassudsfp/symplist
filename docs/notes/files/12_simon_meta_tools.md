# Simon — wrapped meta tools and rules

September 15, 2026. Confirmed direction: Simon exposes Symplist-owned tools wrapping Composio's existing meta tools. Tool names/contracts below are proposed; implementation is pending. This replaces the earlier custom external-capability registry proposal.

## One Simon interface

Simon calls an AI SDK tool owned by Symplist. The wrapper validates account/task access, applies rules and approval checks, delegates to the appropriate Composio session, and normalizes results/events. Chat shows Simon's action and the real external service/account, not raw Composio meta-tool names.

The frontend does not call Composio execution endpoints. With `DURABLE=false`, wrappers execute in Nest; with `DURABLE=true`, they execute in Trigger. Nest remains the confirmed frontend event delivery path. The same wrapper package and authorization contracts are used in both runtimes.

This is a product abstraction, not a claim that integration execution happens entirely on our servers. Technical documentation and operator diagnostics identify Composio as the integration provider.

## Wrapped external meta tools

| Simon/Symplist tool | Composio implementation | Chat activity example |
| --- | --- | --- |
| `search_tools` | `COMPOSIO_SEARCH_TOOLS` | Finding calendar actions |
| `get_tool_schemas` | `COMPOSIO_GET_TOOL_SCHEMAS` | Checking calendar action details |
| `manage_connections` | `COMPOSIO_MANAGE_CONNECTIONS` | Connect your calendar to continue |
| `execute_tools` | `COMPOSIO_MULTI_EXECUTE_TOOL` | Checking your calendar |

Composio already provides discovery, schema retrieval, connection management, and multi-tool execution. Reuse these rather than recreate an external catalogue or planner. Its documentation describes their shared session context and cautions that reference schemas are not guaranteed backward-compatible. Pin SDK versions, adapt actual supported schemas, and contract-test the wrapper. [Composio meta tools](https://docs.composio.dev/toolkits/meta-tools), [session API](https://docs.composio.dev/reference/api-reference/tool-router).

`search_tools` accepts a bounded query describing the requested external action and returns scoped tool references, descriptions, connection requirements, and necessary workflow guidance. `get_tool_schemas` retrieves schemas for those references. `manage_connections` checks or initiates an approved connection workflow; it never obtains user consent on its own. `execute_tools` accepts validated discovered actions and their arguments, and reports per-action results.

Tool reference/session mappings are server-owned. If user-facing aliases replace upstream slugs, maintain an exact reversible mapping rather than guessing identifiers. Preserve the session context required between calls and bind it to the authenticated user/task workflow. Never accept arbitrary user IDs or another user's session IDs from model arguments.

## Native Symplist tools

Keep these small meta tools alongside the four wrappers:

- `task_context`: bounded task metadata, document revision, authorized subtask references, and known section read positions; no full document body.
- `rules_read`: versioned application-maintained workflow rules for the relevant domain.
- `user_ask`: a concise persisted question in the same task conversation when information is genuinely missing.

Native task/document action tools remain Symplist MCP tools, including outline, search, section reads/updates, changes, diffs, history, and restore. See [06_document_tools.md](06_document_tools.md) and [11_document_versioning.md](11_document_versioning.md). Keep their authorization and actual Git/encrypted R2 bundle/D1 publication path within Symplist; do not send document contents to Composio simply to make tool naming uniform.

This gives Simon seven initial meta tools: four wrapped Composio tools and three native tools. Detailed task-action schemas remain to be finalized. Vault access stays an explicit user-selected grant, not an unrestricted read tool.

## Wrapper responsibilities

1. **Identity and scope:** resolve owner, beta access, task scope, connection identity, and session from trusted runtime context. Recheck them for each action; discovery is not authorization.
2. **Stable contract:** validate inputs/results, cap output, map errors, and preserve meaningful upstream status and guidance. Structured normalization must not discard prerequisites or pretend provider failure is success.
3. **Approval:** inspect each underlying action and its exact arguments/account. A generic `execute_tools` call is not blanket approval for its contents. Unknown write effects require conservative handling. Approval is bound to the reviewed payload; changed arguments require review again where policy requires it.
4. **Execution:** allow batches only for logically independent actions. Sending an email based on a preceding fetch must wait for that fetch; don't treat it as a parallel batch. Track per-action success, failure, or uncertainty and never retry successful writes as part of a whole-batch replay. [Composio multi-execute](https://docs.composio.dev/toolkits/meta-tools/multi_execute_tool).
5. **Presentation:** record stable Symplist tool-call IDs with task/run/action IDs. UI labels describe actions such as Reading calendar or Sending outline. Keep upstream correlation IDs in redacted operator diagnostics so debugging remains possible. Required OAuth/service disclosures remain intact.
6. **Session lifecycle:** maintain the upstream workflow identifiers across search/schema/connect/execute and handle expired sessions explicitly. Do not silently switch accounts when reconnecting.
7. **Rules:** attach mandatory policies in the runtime; rules are not optional merely because Simon forgot to call `rules_read`. Changes in permissions cannot be overridden by cached tool descriptions.

## No sandbox tools

Do not expose or execute `COMPOSIO_REMOTE_BASH_TOOL` or `COMPOSIO_REMOTE_WORKBENCH`. Maintain an allowlist for available meta tools and discovered action capabilities; block arbitrary code execution even if discovery returns it. Reject unknown tool slugs by default.

For multi-execution, use the supported no-workbench path (`sync_response_to_workbench=false` where applicable). Handle oversized results through bounded pagination or encrypted Symplist object references when supported. If a workflow requires a sandbox, report it as unavailable instead of silently enabling one. Filter/replace sandbox-dependent instructions with an explicit unsupported-step status without losing the rest of the workflow.

Do not expose unrelated upstream feedback/admin tools just because the provider adds them to a session. New tools require deliberate wrapper support and tests.

## Rules Simon follows

| Domain | Required behavior |
| --- | --- |
| Core | Be Simon, remain in the task's persistent conversation, perform authorized work, and report actual outcomes. |
| Capabilities | Use Composio discovery/schema wrappers for external tools; no invented abilities or duplicate external discovery agent. |
| Connections | Use the right authorized account; connecting and action approval are separate; ask only when account choice is genuinely ambiguous. |
| Documents | Check deterministic revision changes, read bounded sections, write with expected revisions, and preserve unrelated edits. |
| Tasks | Keep work attached to the correct task; creating subtasks should serve user work; finishing a reply does not automatically archive the task. |
| Vault | No automatic access; use only explicitly granted items and resolve secret handles in execution without exposing values in prompts/chat/logs. |
| Execution | Honor cancellation/relock, handle per-action uncertainty, and preserve pending questions/approvals in both execution modes. |

Ship rules as maintained versioned application resources. A small core is always present; domain detail is loaded as needed. A task document supplies requirements/context but cannot grant new capabilities, override permissions, or rewrite Simon's system rules. An explicit task-specific instruction feature can be designed later; ordinary document text is not automatically a trusted rule file.

No separate meta-rule editor or tool-administration UI is needed in beta. Show concise inline connection requests, questions, and action status in the existing chat.

## Model-call boundary

Symplist does not introduce another planner or summarization agent. Native document changes, section maps, and diffs remain deterministic code with no model call. However, Composio documents search results that can include execution plans and search strategies. Do not promise that Composio's internal search implementation is inference-free; its internal behavior is provider-managed. [Composio search](https://docs.composio.dev/toolkits/meta-tools/search_tools).

## Example

Simon reads the task's updated section through native MCP tools → calls `search_tools` for an email action → checks schemas/connections through the wrappers → presents the concrete draft for required approval → calls `execute_tools` for the authorized send → reports the per-action result. The user sees Simon working with the selected email service. Composio handles integration discovery/execution behind the wrapper; no additional Symplist agent is spawned.

## Verification before release

Test alias mapping, SDK/schema changes, cross-user session substitution, unavailable/expired connections, exact-argument approvals inside batches, partial failures, duplicate retries, oversized results, sandbox-tool rejection, malicious returned instructions, secret redaction, and event correlation. Run the same wrapper contract under Nest and Trigger. Verify native document diff/index operations do not depend on a model or Composio.

## Scheduling capability and rules

Add the native `task_schedule` operations defined in [deadlines and reminders](15_deadlines_reminders_calendar.md). Resolve natural-language dates using user preferences, return exact delivery times, and require expected schedule versions for mutations. Stored task prose cannot authorize reminders. Firing a saved reminder is deterministic background work, with no Simon invocation. External calendar actions continue through Composio wrappers and require their own scope; a deadline does not create an external event.

## Role boundary and handoff tools

The [handoff specification](16_simon_handoffs_and_artifact_sharing.md) narrows Simon to facilitation and small authorized productivity actions. Add role/handoff and sharing rule domains plus the specified `handoff_prepare`, `artifact_snapshot`, `artifact_share_create`, `artifact_share_list`, and `artifact_share_revoke` native contracts. Heavy coding/research routes to a useful specialist prompt, not an internal specialist loop. Seven initial meta tools above are the discovery/core subset, not the complete application tool inventory. Disclosure uses reviewed snapshots and trusted approval records; share credentials/passwords stay out of model context.
