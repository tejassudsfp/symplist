# Shared loading, failure, navigation, and responsive states

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Create a reusable state board for the full application. Cover first load, region-level skeletons, empty collections, permission denied, not found, offline, reconnecting, expired login, unsaved draft, background save failure, and unexpected service error. Each should say what happened and what the user can do next.

Avoid replacing the entire app with a spinner when only chat or a list is loading. Preserve task identity and layout during requests. Unknown/unauthorized task links should not reveal private names. Offline editing behavior is not implemented yet: show retained local draft with “Not saved” rather than promising offline sync.

For execution, distinguish browser disconnect from agent stop; backend interruption may require explicit retry. Do not promise durable recovery in every installation. Generic user-facing language should avoid exposing Nest, Trigger, D1, API keys, or stack traces. Retry of uncertain external actions belongs to the approval/error design, not an unconditional global Retry button.

Include toast versus inline-error rules, focus management after modal dismissal, route-level error boundaries, and accessible status announcements. Show a dirty-editor navigation confirmation, menu overflow, modal stacking, and mobile keyboard layout. A theme change during loading/streaming preserves state.

Create desktop, 1024 px, and 390 px examples of panel collapse and Page/Chat navigation. Document what is hidden, what remains accessible, and where Back returns. Include reduced-motion variants and enlarged-text examples with long task titles.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
