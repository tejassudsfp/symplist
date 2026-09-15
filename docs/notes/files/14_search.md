# Search — product and build specification

Confirmed requirement: fast, useful, keyboard-accessible search across the user's work. This specification extends the earlier simple search brief. Implementation is pending.

## Three entry points

1. **Quick switcher / command palette — Mod+K.** One compact overlay. Default mode finds tasks by title and returns them immediately; `>` or an explicit Actions choice searches application actions. Clearly distinguish a task result from a command. Provide “Search all content” to open full search with the current query.
2. **Full search.** Search current task titles and current Markdown document contents across active collections by default. Offer explicit filters for Now, Later, Unclassified, Archive, and content type. Chat is a separate selectable content type so it does not swamp document results. Archive is opt-in and visibly marked. Filters are keyboard accessible and visible; no compulsory query language.
3. **Find in current surface.** Inbox search filters that collection, document find searches the opened revision, and chat find searches the selected conversation. The label always states scope. Esc clears/dismisses according to the active surface, without clearing unrelated queries or drafts.

Vault content is never included in global/task search. Its separate search is available only while unlocked. No cross-user or admin backdoor search. Locked beta accounts cannot use the palette to retrieve protected results.

## Result quality

Use deterministic lexical retrieval and ranking initially; no embeddings, automatic summaries, background AI indexing, or model-powered query rewriting are required.

Rank exact task-title matches first, then title prefixes, title terms, section-heading matches, and document body matches. Multiword relevance and phrase matches should be useful. Normalize Unicode/case consistently, support partial terms, and provide bounded typo tolerance for short task titles. Define language/tokenization behavior and benchmark it rather than assuming English whitespace is universal.

Respect the query over recency: modification time can break otherwise similar ties but should not bury an exact match. Highlight matched text safely as text, never unsanitized HTML. Use deterministic snippets around matches, not AI prose. Group multiple section matches under their task and show a count with expand/open actions instead of ten indistinguishable task rows.

Task result: title, collection, optional parent breadcrumb. Document result: task title, heading, bounded matching snippet, current revision, and enough location context to jump accurately. Chat result: task title, speaker (user/Simon), date, and snippet. Archive result: explicit archived treatment, with restore available after opening.

Navigation opens the correct task, selected section or message, and its associated conversation. If the document changed since the result was produced, refresh/resolve against the current revision; explain a missing match rather than jumping to a wrong offset. Searching all historical Git versions is deferred; history-specific search must be explicitly scoped if introduced.

## Interaction

- Focus the query on opening. Up/Down selects, Enter opens/executes, Escape dismisses and restores prior focus. Keep a scrollable active result in view.
- Debounce queries briefly, cancel superseded requests, and disregard late responses. Keep the active query/filter state visible during loading. Do not replace results with an empty-state flash on every keystroke.
- Use bounded result pages and stable server cursors. Pin/index version information where required; explain index freshness separately from results.
- Empty query in quick switcher can show recent tasks, excluding vault and revoked access. Store recent-task references as an explicit account preference; do not persist sensitive raw query history by default.
- Show no matches, malformed optional filters, temporary error with retry, offline/unavailable, indexing pending, and partial-results states. No matches and search failure are different.
- On mobile use a full-height search surface with a visible back control, comfortable filters, and hardware-keyboard support.

## Encryption and indexing

Search is a derived index, never the source of truth. Task/document data remains in its authorized storage, including encrypted Git bundles in R2 and D1 publication/index metadata.

The build must preserve encryption for persistent search content. Do not silently store titles, Markdown, chat snippets, or raw tokens in a plaintext D1 full-text index. Baseline implementation direction: encrypted per-user search-index artifacts in R2, decrypted into bounded user-scoped runtime memory only for authorized searches. Keep only operational index-version/publication references in D1. Select the search library/format during build and test its Unicode, ranking, and memory behavior. This is not a claim that arbitrary full-text search operates directly over ciphertext.

Build/update index content through deterministic application code after confirmed saves/commits/messages. No extra agent is involved. Keep a durable indexing intent and retry/reconciliation path so a crash does not leave data permanently unsearchable. With durable mode off, indexing executes in Nest; it must not require Trigger. Batch frequent changes instead of rebuilding the entire corpus per keystroke. Coordinate concurrent index publishers with a generation check.

Use current documents only in global indexes. Enforce account/task authorization again when rendering results and opening them; index membership alone is not authorization. Invalidate decrypted caches and remove index entries on deletion/revocation. Vault contents never enter this index. Treat external/MCP task-scoped searches as a narrower endpoint than the user's global search.

If indexing is behind the current head, report freshness honestly and fetch the latest task before navigation. Establish explicit corpus/cache/output size limits and a bounded fallback or user-visible indexing/unavailable state. No unbounded scan/decrypt of every historical bundle for each query. Benchmarks must validate the selected approach before claiming it scales.

Avoid raw query/snippet logging and content in error traces. Define encrypted-index key rotation, backup, purge, and rebuild behavior. Search must be rebuildable from authoritative records and current Git heads after an index is lost.

## Proposed performance targets and quality tests

Target immediate overlay opening with no network dependency for rendering, and useful warm results within roughly 300 ms after debounce on the agreed beta corpus. Cold encrypted-index loads may take longer; show a loading state. These are targets to measure, not guarantees. Record corpus size and hardware with results.

Build relevance fixtures for exact/prefix/typo/multiword matches, duplicate task titles, heading and body matches, Unicode, long documents, archived data, and multiple matches per task. Include creation/update/delete, changed revisions, interrupted indexing, concurrent writers, access revocation, two-user isolation, vault exclusion, stale responses, pagination, and keyboard-only operation. Verify no model requests are made by search/indexing.

## Deadline filters

Include explicit Has deadline, No deadline, Due today, Overdue, and date-range filters. Derive date-only/timed comparisons from the [schedule semantics](15_deadlines_reminders_calendar.md), never title text. Label the comparison timezone. Due-date ordering is optional and does not replace relevance by default. Schedule metadata changes refresh filters independently of encrypted document indexing and Git revisions.
