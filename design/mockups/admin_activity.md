# Administration — invite usage and access activity

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the Activity view as a readable audit log of beta access operations: code generated, redeemed, cap increased, expiry changed, invite revoked, account unlocked, and access relocked. Columns: time, actor, action, target, and result; expand for reason and before/after values.

Invite usage tracks seats/redemptions. It is not model usage, subscription tiers, credits, cost per customer, or a weekly allowance. Do not add Free/Pro charts, AI token counters, or reset-quota controls in this beta design. Optional operational telemetry is off by default and outside this mockup scope.

Show filters by date, actor, campaign/account, and action only where useful. Use a concise recent activity list initially instead of a dense reporting suite. Include empty, populated, loading/error, no matches, and event-detail states. Immutable records have no edit/delete control.

A specific example: “Maya redeemed Friends — September” followed by “Tejas increased capacity from 5 to 8.” Display code hints only; never full codes, OTPs, recovery keys, or private user content. All data is fictional in the mockup.

Provide a clear link to the related invite/account and preserve filters on return. Mobile rows can summarize events and open details. The quirky themes must remain orderly and should not add decorative charts merely to differentiate themselves.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
