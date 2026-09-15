# Email OTP verification

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a verification step reused for existing-account login and new-account verification. Heading: “Check your email.” Show the destination email with an Edit email action. Provide a code input and Verify button, plus resend with a clear cooldown. A six-digit OTP is a mockup assumption; annotate that it is configurable and avoid backend claims.

Use one semantic input with optional visual cells, supporting full-code paste, one-time-code autofill, keyboard editing, and screen readers. Show the code prominently enough to use comfortably without making the screen feel like a banking portal.

States: empty, partially entered, verifying, incorrect, expired, too many attempts, resend cooling down, resent, and delivery error. An expired code offers a new code; resend never means sending a beta invite. Explain limits through calm actionable copy, not alarming security banners.

Successful existing-user verification routes according to access: unlocked → app/onboarding; locked → beta gate; administratively blocked → access-revoked screen. New users reach the locked beta gate after verification. Do not equate email verification with admission.

Include a mobile keyboard/paste state and desktop state. This layout can be reused by vault reset, but vault reset must visibly state its different purpose. Prototype success to the gate and error to resend. Keep code values fictional and never use real customer addresses.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
