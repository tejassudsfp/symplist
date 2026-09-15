# Search tasks and documents

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the full-content search surface described in [14_search.md](../../docs/notes/files/14_search.md). Default scope is active task titles and current documents across Now, Later, and Unclassified. Expose explicit collection and content-type filters; Archive and Chat are opt-in. Inbox-local search still defaults to that collection. Always show scope.

Results rank strong title matches first and show bounded matched snippets for document sections or messages. Group multiple document hits beneath their task. Use realistic exact, prefix, typo, and multiword examples. Highlight matches safely, show section headings and collection/parent context, and label archived results. Opening a result navigates to the relevant section/message and keeps the task's page/chat paired.

Show query focus, loading, results, no matches, failed search, partial/indexing results, stale-result refresh, and long snippets. Include an empty-query prompt without persisting private query history by default. A task edited since indexing may need a refreshed jump; show that state honestly. Vault items and other users' data never appear.

Up/Down moves selection, Enter opens, Escape returns to prior focus. Show visible filter controls accessible without a mouse. Preserve query/filter state when returning from a task. The [command palette](command_palette.md) provides quick title search and forwards its query into this richer surface.

Mobile uses a full-height search screen with comfortable filters and back navigation. Provide a tablet layout and contrast/focus states in both brightness modes. Search/indexing is deterministic and uses encrypted stored data; do not invent AI search summaries, semantic-chat boxes, or instantaneous-results promises while the index is loading.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
