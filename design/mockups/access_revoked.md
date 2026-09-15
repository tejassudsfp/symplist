# Access paused or account restricted

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the signed-in screen for an account whose beta grant has been administratively revoked or whose account is suspended. It differs from a new locked account: another invite must not let the user bypass the restriction. Do not include a redeem-code form in this state.

Use a calm heading such as “Access is currently paused.” Provide the signed-in email, a short explanation that access needs to be restored by the operator, Check access, Sign out, and permitted account-management actions. A contact destination may be shown only as a configured placeholder; do not invent a support address or promise response times.

Show access paused on initial navigation and access changing during an open task. The latter should replace protected content with this screen and explain that further work was stopped where possible. Do not promise cancellation of actions already completed or pretend unsaved content was saved. Sensitive content must not linger in the backdrop.

Include restored-access state leading to the app, failed access check, and session-expired variant leading to OTP login. Avoid punitive copy or red alert walls. The theme may remain personalized, but decorative motifs should be absent from restriction messaging.

Desktop and mobile frames are required. Annotate how focus moves when the application transitions here unexpectedly, and how a toast alone would be insufficient for a blocked account.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
