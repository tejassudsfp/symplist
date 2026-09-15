# Email entry

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the first entry into Symplist. The screen should make signing in feel quick and ordinary, with a small wordmark, one concise line about the product, a labeled email field, and Continue. Include a quiet “Closed beta” note: registration is possible, but app access requires a personally shared invite. Keep this as an application entry, not a marketing landing page.

Existing email advances to the OTP screen after successful delivery. Unknown email advances to explicit signup confirmation. Do not add passwords, social login, an invite-code field here, or pricing. Use maya@example.com as fictional input. A footer can link About and the author; no fabricated repository URL.

Show empty, typed valid address, invalid format, submitting, email service failure, and throttled retry states. Keep the address on errors and provide an actionable retry. The button must not claim the code was sent before delivery submission succeeds. Loading should not move the form.

On mobile, keep the form within comfortable reach without crowding the keyboard. Autofill, visible labels, email keyboard, enter-to-submit, and focus ordering need annotations. The selected theme should affect this screen without ornate decoration. Provide one small optional theme motif, leaving the form dominant.

Prototype both branches: known email → OTP; unknown email → signup confirmation. Keep account lookup's explicit behavior rather than replacing it with a generic always-success screen.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
