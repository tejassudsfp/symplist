# Agent action review and selected vault sharing

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design an inline chat approval card, plus an expanded detail sheet when needed. Example: the agent proposes sending the project outline through a connected email account. Display service/account, recipients, subject, body preview, and precisely what will happen. Primary: Approve and send. Secondary: Don't send. Offer editing the draft before approval if the design can preserve a fresh review of final content.

Approval concerns a concrete action; do not use vague “Allow agent access” copy. Show approved/running/succeeded, denied, expired, changed arguments requiring fresh approval, disconnected account, and uncertain outcome. An uncertain send must say the result could not be confirmed and avoid a blind Send again primary action.

For document edits that do not require approval, show a simple result with revision access rather than forcing this card for every edit. Consequential external actions remain clear and reviewable.

Include a separate “Use a vault item” interaction: choose one named item, identify the task/tool and purpose, unlock if necessary, and explicitly confirm limited sharing. Mask the secret; do not paste it into chat or grant access to the whole vault. Make Cancel equally reachable. Show revoked/expired grant state without exposing the value.

Keyboard focus, screen-reader status announcements, narrow-screen scrolling, and sticky actions need annotations. Use restrained styling in quirky themes: this surface needs trust and clarity more than decoration.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Specialist handoff and artifact actions

Follow [Handoff](handoff.md), [Share artifact](artifact_share.md), and [Manage links](artifact_shares.md). Simon can prepare full specialist instructions from bounded task context; it does not perform heavy coding/deep research itself. Show editable prompt and reviewed release as separate steps. No link is published or sent merely because a suggestion appears. Existing task chat remains the same conversation.
