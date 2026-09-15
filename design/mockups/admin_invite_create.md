# Administration — generate and privately copy invites

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a compact Generate codes form. Default: one independent single-use code, valid seven days. Fields: optional label/note, expiry, maximum redemptions. Advanced options may include optional bound email and a batch count. Make independent-code batch versus one multi-use campaign code explicitly different choices.

The operator creates codes to keep and share personally. There is no Send invitations, auto-distribution, email recipient list, or signup-triggered generation. The bound-email field restricts who can redeem; it does not send mail. Put this explanation near that field.

After generation, show a one-time secret display with Copy code or Copy all codes. Use grouped fictional strings marked “Demo code — not redeemable” in the prototype. Explain “Save these now. Full codes won't be shown again.” Offer an explicit Done action; do not imply closing saves them to a recoverable admin list.

Required states: default, advanced, batch, invalid expiry/cap, generating, generated one, generated batch, copy success/failure, navigation-away warning before acknowledgment, and request result uncertain. For uncertain creation, allow checking the operation outcome instead of blindly issuing another batch.

A lost code is revoked/replaced rather than revealed from inventory. Show how returning to Invites displays only hints and metadata. Mobile copy behavior and scrolling a large batch must remain usable. Use no confetti or email envelope success imagery.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
