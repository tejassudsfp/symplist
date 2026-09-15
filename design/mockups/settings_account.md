# Settings — account and privacy

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a modest Settings shell with Account, Appearance, Keyboard shortcuts, Connections, and Agent connections navigation, plus Back to workspace. Sections may share a left list on desktop and a simple subpage selector on mobile. There is no Billing section in beta.

Account shows editable display name, verified email, a restrained beta-access indicator, sign out, and account deletion in a separate danger area. Treat email as read-only for this release unless an email-change flow is separately specified. Do not add passwords or assume email OTP grants vault access.

Show name editing, saving, saved, validation/network failure, and unsaved changes on navigation. For account deletion, show a confirmation explaining task/doc/chat/vault data impact and any asynchronous deletion process, with fresh verification as a proposed safeguard to be annotated. Do not invent a retention promise or deletion-completed state before confirmation.

Locked accounts get a restricted account-management variant without links into the protected app. They can view identity and request deletion/sign out, but cannot configure connectors or open vault content.

Include no avatars-upload flow unless marked optional; initials are sufficient. On mobile, keep destructive actions separated from ordinary save actions and avoid placing them next to the primary navigation button. Use calm plain language rather than a wall of privacy/legal copy.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Optional product analytics

Add a Privacy section with a default-off Share product usage toggle. Explain what is measured in ordinary language and link the privacy notice. Show saved/failed preference states and deployment-disabled state. Turning this off does not disable tasks, AI, reminders, or authentication. No private content or replay is collected; follow [analytics requirements](../../docs/notes/files/17_analytics.md).
