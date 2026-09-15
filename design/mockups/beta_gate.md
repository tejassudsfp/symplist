# Verified account awaiting beta access

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the screen after verified signup when the account is still locked. The person is signed in but cannot view tasks, documents, chat, vault, connections, or MCP settings. Do not show the unlocked app behind a translucent overlay; private content should not render at all.

Heading: “You're signed in.” Supporting copy: “Symplist is in closed beta. Enter an invite code shared with you to unlock your account.” Provide one generous paste-friendly code field and Unlock account. The current email, Switch account/Sign out, and minimal account management/deletion access remain available.

Invite codes are generated privately by the owner and shared personally. There is no Send me a code button, automatic invitation, waitlist ranking, referral system, or promised access date. A quiet “Don't have a code? You can return when one is shared with you” is sufficient.

Show empty, pasted grouped code, redeeming, generic invalid/unavailable code, exhausted/expired presentation without revealing another email, temporary network failure, and successful unlock. Use a success transition directly into onboarding; no celebratory full-screen confetti.

Also show an admin-unlock refresh state: Check access can recheck admission, but it must not send a code. On self-hosted deployments with the beta gate disabled, this screen is skipped; annotate that behavior. Provide mobile and desktop plus code-paste interaction.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
