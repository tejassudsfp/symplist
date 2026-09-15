# Actual Git document history — build specification

September 15, 2026. **Confirmed decision: use actual Git for beta document versioning, with encrypted Git artifacts in R2 and publication/index metadata in D1 via REST.** This supersedes the earlier custom immutable-revision engine. This is documentation only: the application and versioning implementation have not been built. Do not mistake example contracts below for existing code.

## Scope and user experience

Every task document has real Git commits, parentage, authorship, timestamps, comparisons, and restoration. Simon and the user edit the same document through authorized application services. Git is the document history engine; D1 is the application index and publication authority, not a competing custom history format.

Keep the existing History / Compare / Restore UI. Users do not need staging, manual commit commands, a terminal, or a branch selector for ordinary task work. Actual Git is selected now; a full Git-hosting product with public remotes, arbitrary repository import, and branch collaboration is not implied.

Scope is Markdown inside Symplist, not initializing a repository for these local planning notes. Keep chats, OAuth tokens, application secrets, and vault contents outside the ordinary task repository. Vault recovery remains governed by its separate specification.

## Repository boundary

Build baseline: one private bare repository per task, containing `document.md` on a service-managed `main` branch. Bind it to an immutable owner/task identity, not the task title or Now/Later/Unclassified placement. Renaming or moving a task does not lose document history. A subtask owns its own page/history.

This boundary fits the existing one-page-per-task product and limits reconstruction to the selected task. It does not provide atomic commits across multiple tasks. If workspace-wide file trees become a requirement, revisit repository granularity explicitly rather than silently pooling all users into one repository.

Git paths and refs are application-generated. Callers pass task/revision/section references, not filesystem paths, arbitrary Git ref expressions, remote URLs, or shell commands. Each request must authorize the authenticated user, beta access, task scope, and operation. A commit hash is not permission to read it.

## Runtime and Git operations

Use a shared versioning service compatible with Nest and Trigger. Local execution invokes its tool operations inside Nest; durable execution invokes the same contract inside Trigger. Hosting/API infrastructure can still perform ordinary user-driven document saves in Nest. Ship a pinned supported Git executable in both execution environments, or select and validate an equivalent Git library before implementation; native Git CLI is the baseline.

Use trusted service code and fixed argument arrays with no shell interpolation. Create blobs, trees, and commits through Git plumbing; use explicit parent commit IDs. A bare repository avoids an agent-accessible working directory. This is not a sandbox feature and Simon never receives arbitrary shell execution.

Reconstruct repositories in private temporary directories from authenticated encrypted artifacts. Disable ambient Git configuration, hooks, credential helpers, external diff/text conversion, signing commands, and uncontrolled transports. Bound input sizes, output sizes, process duration, concurrent reconstruction, and disk usage. Remove temporary plaintext after operations, and document cleanup after crashes. Neither Render disks nor Trigger local files are the durable source of truth.

## R2: encrypted Git artifacts

Baseline storage: a self-contained Git bundle containing the published history of the task's `main` branch. Each publication writes a new immutable encrypted object under an opaque identifier. Git bundles provide real repository history that can be reconstructed using Git; R2 itself is not a normal Git remote or POSIX filesystem.

Full bundles are a deliberately simple starting format. They duplicate history across retained artifacts and their transfer/reconstruction cost grows with the repository. Set documented document/repository size limits, measure cold and warm latency, and bound the implementation before release. Never silently discard history when a size limit is hit. Incremental bundles or packed-object storage with checkpoint manifests may be added after profiling; incremental bundles require their prerequisite artifacts to remain reachable.

Git must see decrypted Markdown inside the authorized runtime to compare it meaningfully. Encrypt the complete bundle after Git processes the content, rather than committing encrypted Markdown and expecting useful text diffs. Encrypt commit messages, authorship, filenames, and history as part of the bundle.

Use the existing AES-256-GCM content-key system with unique nonces and versioned keys. Authenticate owner, task/repository, artifact identity, and format/key version as additional authenticated data. Keep keys outside D1/R2 ciphertext storage. Do not use visible plaintext content hashes as globally shared object names. A plaintext export, if offered later, is an explicit authorized operation and must be identified as containing the task's history.

## D1: publication and metadata

Specify tables/indexes for:

- Repository identity: owner, task, current published head, publication generation, and artifact reference.
- Published commits: commit ID, parent(s), repository identity, publication sequence/time, artifact reference, and format/key version. Store sensitive descriptive metadata encrypted or resolve it from the encrypted repository.
- Idempotent write requests: scoped request ID, protected input fingerprint, status/result, and retention window.
- Agent read receipts: user/conversation/run, task, exact revision, section/range, and checkpointed delivery state.

The published Git graph is authoritative document history. D1 controls which candidate graph is committed for the application. Indexes must agree with reachable commits. Do not publish a D1 revision unrelated to the Git commit it references. Git hashes and structural metadata still reveal information; document which operational fields remain queryable and protect all user-authored descriptive content.

## Atomic publication and concurrency

Implement and test this protocol using D1's actual REST-supported SQL behavior:

1. Authenticate and authorize the edit. Resolve an explicit expected base commit and a unique scoped request ID. An exact retried request returns its recorded result; reusing an ID for different input fails.
2. Read the published repository head and artifact. Verify it matches the requested base before preparing a candidate.
3. Download/decrypt/reconstruct the repository. Verify expected refs, object integrity, and permitted ancestry. Apply the specific edit and create a real child commit with server-validated user or Simon-run provenance.
4. Bundle/encrypt/upload the candidate under a new immutable R2 key. Confirm upload success before publishing any pointer to it.
5. Atomically record the publication and advance the D1 head only if the expected base/generation still matches. Use one supported conditional statement or tested atomic transaction/batch pattern; do not assume a transaction can remain open across separate REST requests.
6. If another writer won, do not overwrite it. Return a conflict/current revision and preserve the user's draft or candidate for bounded recovery/review. Default beta behavior is conflict review/retry, not silent automatic merging.
7. If publication response is uncertain, recover by request ID. Do not immediately delete the uploaded object: publication may have succeeded. Collect unreachable candidates only after a grace period and authoritative reachability checks.

There is no cross-service transaction across Git, R2, and D1. Upload-before-publication can leave unreferenced artifacts but avoids a committed head pointing at an unuploaded object. A local Git ref lock or `update-ref` expected-old check helps local correctness but cannot coordinate independent Nest/Trigger instances; the D1 conditional publication is still required.

Concurrent edits to different sections may eventually use a three-way merge, but conflict-free text does not prove semantic correctness. Preserve the latest saved page and the draft whenever review is needed. Backend retries must not repeat external side effects just because a document commit failed.

## Autosave, history, and restore

Separate draft persistence from meaningful visible revision grouping. Commit coherent debounced user saves and completed agent document-edit operations; do not create a commit for every streamed token or keystroke. “Saved” must mean the publication succeeded, not merely that text was placed in a temporary repository.

A restore creates a new commit whose document matches the selected older revision and whose parent is the current published head. Record the source revision. Never implement ordinary Restore with history-erasing reset/force-push. Restoring Markdown does not undo an email, calendar event, or other external action.

History supports chronological pagination and authored provenance. Net diff and chronological history are different: content changed and later reverted can have an empty net diff while its intervening commits remain visible.

## Deterministic change retrieval — no additional agent

Use Git to obtain revision comparisons and a Markdown parser to map changes to sections. Return structured statuses such as Added, Modified, and Removed, plus bounded diffs on demand. No background summarization, extra model call, or new agent is involved in saves, indexing, or generating change lists. Simon consumes results during its existing AI SDK loop.

Keep the established MCP contract, using Git commits as revisions:

| Tool | Required behavior |
| --- | --- |
| `task_document_outline` | Paginated heading/section references at a specified commit; no body dump |
| `task_document_read_section` | Bounded section/range at an explicit commit; revision, cursor, and truncation included |
| `task_document_search` | Bounded authorized snippets and section references, excluding vault content |
| `task_document_changes` | Changes since a baseline; resolve and pin a target commit for all pages |
| `task_document_diff` | Bounded hunks between two explicit published commits, optionally scoped to relevant sections |
| `task_document_update_section` | Expected-revision edit that publishes a real Git commit |
| `task_document_history` | Paginated published commit history/provenance |
| `task_document_restore` | New commit restoring old content, guarded by expected current revision |

Validate both endpoints belong to the authorized task and supported published history. Invalid/expired/deleted baselines require explicit resynchronization, never a fabricated “no changes.” Pin target revision across pagination even while more edits arrive.

Parse Markdown structurally, including fenced code, duplicate headings, heading-free text, and nested sections. Section reads must not implicitly return every descendant. Oversized sections paginate. Revision-scoped IDs may change on heading moves/renames; report conservative add/remove when continuity cannot be reliably established. Do not claim Git inherently understands Markdown headings.

The service may decrypt enough of a document/repository to calculate changes; this does not authorize injecting the full result into Simon's prompt. Apply limits to tool output and total retrieval per turn independently of storage size.

## Simon's read position

Track section/range read receipts rather than assuming a global last-read commit means the whole document was read. A user, Simon conversation, and third-party agent can each have different baselines. Advance only for successfully delivered/checkpointed content, not an entire truncated result.

On resume, compare known section baselines with current history, list changed/unseen/deleted sections, and let Simon fetch needed context. After context compaction or a new session, a durable receipt is not proof that the model still remembers the old text. Reread bounded current/baseline excerpts when a patch alone would be insufficient. Revalidate the base before writing.

## Recovery, deletion, and operations

Document and test encrypted bundle restore, D1 index consistency, version/key rotation, orphan cleanup, and backup restoration. Retain old wrapping/decryption keys as required until historical artifacts are migrated or deliberately retired. A new encryption key must not strand old history.

History can contain secrets removed from the current document. Define purge/retention for account deletion, accidental secret removal, archived tasks, artifacts, repository caches, exports, and backups. Immutable editing history does not exempt data from deletion policy. Never include vault history in a normal task bundle.

Independent full bundles simplify recovery but may multiply storage. Benchmark representative histories before choosing limits; document failure behavior and an incremental-storage migration path. In deployment instructions, require the Git binary/library and temporary-storage permissions on both Render/Nest and Trigger, and later AWS. Provide a clean self-hosted setup without a proprietary Git service dependency.

## Acceptance criteria for the build agent

- Real commits and parent history can be inspected after decrypting a bundle with standard Git; restoration adds a commit and preserves previous history.
- Normal reads, section edits, diffs, history, and restore work through authorized application/MCP contracts, with no shell available to Simon.
- Wrong-key, modified-artifact, cross-task, cross-user, invalid-commit, and unapproved-operation requests fail without plaintext leakage.
- Concurrent same-base writes yield one publication; retries return the original result; mismatched retry payloads are rejected.
- Crashes before upload, after upload, during publication, and after publication response loss recover without losing a published head or double-publishing.
- User and Simon authorship is preserved inside encrypted history, and meaningful UI history is not flooded by keystroke commits.
- Headings, nested/code content, pagination, stale cursors, unread sections, compacted context, and changed-then-reverted content behave as specified.
- No background model call occurs for Git/history/diff operations. Native and durable executors share the same behavior and constraints.
- Test artifact limits, temporary plaintext cleanup, repository restore, key rotation, deletion reachability, and clean self-hosting. Distinguish local/mocked tests from live R2/D1 validation.

## References for implementation

[Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects), [commit-tree](https://git-scm.com/docs/git-commit-tree), [git diff](https://git-scm.com/docs/git-diff), [update-ref](https://git-scm.com/docs/git-update-ref), [Git bundle](https://git-scm.com/docs/git-bundle), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/). Verify current API/package contracts when implementation begins. No implementation or cloud deployment is authorized by this document alone.

## Shared snapshots

[Artifact sharing](16_simon_handoffs_and_artifact_sharing.md) exports only reviewed Markdown from a pinned Git revision/section selection. Never expose encrypted repository bundles, commit history, or private later edits through a read-only artifact link. Updating a publication requires a new snapshot and grant.
