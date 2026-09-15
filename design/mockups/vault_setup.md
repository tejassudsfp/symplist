# Vault — first-access key setup

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design first access to Vault after beta admission. Explain: “Keep sensitive notes and keys here.” Ask the user to create and confirm a custom vault key, with show/hide controls. Button: Create vault. Clarify that this key is separate from email login and can be reset through email verification.

The screen must not claim user-only decryption or end-to-end encryption. Keep the cryptographic implementation out of the form. A concise expandable explanation can state that recovery is supported by the service, preserving vault contents on reset.

Required states: empty, partially entered, mismatch, insufficient key strength according to a configurable policy, submitting, creation failed, and created. Use a restrained strength/help indicator, not a mandatory complicated checklist full of symbols. Preserve sensible input on network failure without exposing it elsewhere.

Show a first-access race where the vault was set up from another device: offer Unlock existing vault rather than overwriting it. On successful creation, enter the empty vault list. No keys or items should be automatically shared with the agent.

Desktop and mobile, keyboard form behavior, visible labels, and reveal-control focus states are required. Avoid fake vault-door animations, padlocks on every field, or security theatre. The theme can style the page, while sensitive messaging remains calm.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
