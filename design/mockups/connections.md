# Settings — service connections

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the connector catalogue and connected-account management surface. Separate “Connected” from “Available” without producing a huge app-store dashboard. Include a lightweight search if the catalogue warrants it. Proposed examples are Gmail, Google Calendar, and GitHub; identify them as sample launch choices.

A connected service shows account identity, health (Connected / Needs attention), a concise capability summary, and Manage. Multiple accounts for one service must be distinguishable, for example Personal versus Work. Do not show OAuth tokens or vendor implementation names such as Composio to ordinary users unless necessary.

Required states: no connections, connected list, search/no results, connecting, provider authorization handoff, cancelled auth, callback failure, expired/revoked connection, reconnecting, and disconnect confirmation. Provider login happens in its own hosted flow; do not design an imitation password collector.

Disconnect copy explains that future agent actions using the account stop; it does not claim previously sent content is recalled. Show a task approval linking here when an account needs reconnection, then returning to the same task without silently sending the pending action.

Keep Skip/Back available during onboarding reuse. All admitted beta users can connect accounts. Do not include billing gating, integrations usage charts, or automatic account sharing between users. Show desktop detail sheet and mobile service detail view.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
