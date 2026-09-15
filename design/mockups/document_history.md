# Document revisions and conflict review

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a secondary revision surface entered from a task page. Keep the selected task title and a clear Back to page action. Show a compact list of revisions with actor (You or Task agent), relative time with exact-time access, and section description such as “Updated Next steps.”

Selecting a revision shows a readable preview and comparison to the current version. Differences must not rely solely on red/green: use added/removed labels and line/block structure. Avoid a developer-grade repository browser. Provide Restore this version with a confirmation explaining it creates a new current revision and preserves history.

Required states: history available, no previous versions, loading/error, revision preview, restore confirmation, restoring, restored, and restore conflict because the page changed after preview. A restore never silently discards fresh edits.

For simultaneous user/agent edits, show “This section changed while you were editing” with your draft and the saved version. Offer review/copy of the draft and an explicit choice for the affected section; do not pretend automatic merging is always possible. Preserve unrelated sections.

On mobile, revisions and preview are sequential screens rather than tiny side-by-side columns. Theme variations must keep diff readability. Annotate selection, escape/back, scroll preservation, and the relationship between page revision history and chat messages.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Confirmed storage behavior

Actual Git is the history engine. Revisions correspond to real commits, but default UI labels remain History, Compare, and Restore. Restoring produces a new commit and preserves earlier versions. Technical commit IDs may be available in secondary details, without adding staging, terminal, branch, or pull-request screens to the current scope. This is a mockup requirement only; no versioning implementation exists yet.
