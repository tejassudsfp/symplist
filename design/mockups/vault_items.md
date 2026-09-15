# Vault — item list and detail

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the unlocked Vault as a separate workspace destination. Top bar: Vault, search within the unlocked vault, Add item, and Lock vault. Use a calm two-pane list/detail arrangement on desktop; one surface at a time on mobile.

Sample items: “Personal API key” (secret), “Recovery notes” (secure note), and “Home network notes” (secure note). All values are fictional. Rows show title and type, with minimal modified metadata. Selected secret values remain masked until deliberate reveal. Do not place plaintext previews in the general task inbox or global search.

Required states: empty with Add item, populated, selected secret masked/revealed, selected Markdown note, search/no results, loading/error, locked during inactivity, copy feedback, and editing entry. Revealed/copy interactions must not create toasts containing the secret itself. Avoid promising automatic system clipboard erasure.

Show create/edit navigation, a delete confirmation scoped to one item, and a sharing entry point only when an explicit task/tool context exists. The vault master key is never an item to share. A compact “Used by this task” grant indicator may be proposed, but it must not suggest every agent can browse the vault.

Render this screen in all eight theme/mode combinations. Keep secrets readable when intentionally revealed, even in decorative themes. Use restrained empty-state detail rather than dramatic lock imagery.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
