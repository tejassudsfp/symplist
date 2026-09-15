# Administration — beta invite inventory

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a protected administration surface accessible only to the operator/admin. Use a compact Beta administration shell with Invites, Accounts, and Activity. It must not appear in ordinary-user menus.

Invites lists label/campaign, short code hint, status, redemption usage such as 1 of 1 or 3 of 10, expiry, and created date. Top action: Generate codes. Provide useful status filters and search without turning this into an analytics dashboard. Full code strings are never recoverable in the inventory.

Actions: view redemptions, increase capacity, extend expiry, revoke future redemption, and copy a non-secret reference if useful. Revoking an invite does not revoke admitted users; communicate that in the confirmation and offer a separate link to account management. Do not provide “Reset usage to zero.”

Show active, exhausted, expired, revoked, empty, loading, and fetch failure. Example campaigns: “Friends — September” and “Design feedback.” Redemptions show verified account identities and dates, never private task/chat/vault data.

Create a detailed view with uses and remaining seats. Capacity edits must not go below already-consumed uses. Show save failure and concurrent update. Batch actions should preview affected invites before confirmation. There is no auto-email action; the operator shares generated codes personally.

Desktop table and mobile card/list detail are required. Keep styling cohesive with themes while retaining administrative clarity.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
