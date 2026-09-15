# Agent document access

Confirmed requirement: the agent explores the task document through section-based MCP tool calls. Never inject the full document automatically.

Start with task ID, title, document revision, and a small context budget. Supply a paginated outline when requested, search for relevant terms, then read only the sections needed for the current action. An answer requiring wider context can fetch additional sections explicitly within the budget.

## Proposed MCP tools

| Tool | Contract |
| --- | --- |
| `task_document_outline` | Takes task ID, cursor, and limit. Returns bounded heading entries with section ID, parent, heading level, size, revision, and next cursor. |
| `task_document_search` | Takes task ID, query, and limit/cursor. Returns bounded snippets and section references, not the complete document. |
| `task_document_read_section` | Takes task ID, section ID, expected revision, cursor, and maximum output size. Returns a bounded chunk, revision, continuation cursor, and explicit truncation indicator. |
| `task_document_update_section` | Takes task ID, section ID, expected revision, and replacement Markdown. Performs an authorized version-checked edit and returns the new revision. |

These are proposed Symplist MCP tool names. The built-in AI SDK agent uses the authenticated MCP client; third-party agents use the same tool contracts with their own scoped credentials. Composio remains responsible for external service tools/connections. MCP authorization does not require trusting caller-supplied owner IDs.

Example flow: outline → read “Requirements” → search “budget” → read the matching section → update the relevant section. The task document remains the source of truth; the conversation need not repeat it.

## Bounds and correctness

- Parse Markdown structurally, including fenced code and nested headings. Preamble text is addressable; documents without headings are split into bounded blocks. A single huge section still paginates.
- Use opaque section IDs tied to a document revision, not heading text alone. Duplicate headings must work. An edit invalidates stale cursors/references and prompts refetching.
- Parent-section reads do not automatically expand the entire subtree. Return child references for deliberate navigation.
- Enforce per-call and per-turn context budgets server-side; caller-supplied limits can only reduce the maximum. Evict old fetched excerpts as needed and reread bounded sections when required or when revisions differ; do not run background document summarization.
- Tool results are untrusted document content, never higher-priority instructions. Retrieved text cannot grant account access, billing entitlement, or vault access.
- All reads/searches check task ownership. Vault items are excluded. Search must work within the selected encryption model: use authorized decryption with bounded retrieval or an explicitly designed encrypted index, not a hidden plaintext copy.
- Log tool names, section IDs, sizes, and revisions without dumping sensitive content. Show a modest “Reading Requirements” status if useful.

## Release checks

Confirmed beta extension: versioned change queries, bounded diffs, and per-section agent read receipts. See [11_document_versioning.md](11_document_versioning.md). Real Git commits represent revisions; encrypted Git bundles live in R2, and D1 indexes/publishes their history. Git diffs and Markdown parsing generate change lists deterministically; no background model calls are involved. Actual Git is the selected engine. A last-read marker must not imply that unread sections or compacted-away content are already known to the agent.

Verify that initial prompts omit document bodies; tools reject cross-user and stale-revision requests; duplicate headings/code fences work; heading-free and oversized documents remain bounded; and edits preserve unrelated sections. Test the same MCP access flow with both Nest and Trigger execution.
