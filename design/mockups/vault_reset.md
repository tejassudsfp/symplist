# Vault — reset key through email OTP

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design a short reset flow entered from Forgot key. Step 1 explains that a fresh verification code will be sent to the account's verified email and that existing vault contents are preserved. Primary: Send reset code. Back returns to Unlock.

Step 2 is clearly labeled “Verify vault reset,” with destination email, OTP input, Verify, resend cooldown, and change-account exit via normal account login. It must not be confused with invitation redemption or signup OTP. Step 3 asks for a new custom key and confirmation. Final action: Reset vault key.

Show request/send failure, incorrect/expired OTP, too many attempts, verified short-lived authorization, mismatched new keys, reset saving, reset succeeded, concurrent reset from another device, and failed commit. If verification expires before submission, request a new code without suggesting data was erased.

Success says the key was updated and asks for re-unlock or returns through a verified unlock state. Explain briefly that other vault sessions will need to unlock again. Do not claim old plaintext copies can be recalled. A reset notification email appears in transactional_emails.md.

No cryptographic jargon on the main form, no data-loss threat inconsistent with recovery, and no user-only decryption claim. Desktop/mobile frames and a connected three-step prototype are required. Preserve clear cancel/back paths and avoid an elaborate multistep wizard.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
