# Vault — locked and unlock

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the normal locked vault screen: heading “Unlock your vault,” one key field, reveal control, Unlock, and Forgot key? The user is already signed in and admitted to beta; do not ask for email/password login again unless the account session expired.

The locked state must hide entry names, previews, secret counts if they reveal sensitive metadata, and decrypted items. Do not blur an already rendered private vault list behind the form. Keep a safe route back to tasks.

Show empty, entered, unlocking, incorrect key, throttled attempts, temporary error, and session expired. A separate inactivity-lock variant explains briefly that the vault locked and asks for the key again. Do not claim a wrong key deleted data or lock the whole account.

Forgot key routes to the vault reset flow using a fresh OTP. Ordinary login OTPs cannot be reused. On success return to the originally requested item or the vault list. If entry came from a task's “Use a vault item” action, preserve the requested sharing context and require explicit selection/confirmation after unlock.

Show desktop and mobile. Mask by default; allow deliberate reveal. Ensure keyboard submit, clear error association, and focus return to the key field after an incorrect entry. Do not offer Remember forever or store-key convenience without a separately specified design.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
