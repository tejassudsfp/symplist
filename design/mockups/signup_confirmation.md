# Permission to create an account

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Create a compact continuation of email entry. Show the entered email, “No account found,” and “Create an account with this email?” The primary button is Create account; the secondary action is Use another email. Explain in one short line that beta access still requires an invite shared by the owner.

Only an affirmative action creates the pending account and sends verification OTP. This is not a plan chooser or an automatic signup. Do not send or promise an invite. Show the same form identity as email entry so the transition feels continuous.

Required states: resting confirmation, submitting, failure to send verification email after pending registration, and a race where the address now belongs to an existing account. For the race, offer continuing with verification without asking users to resolve database terminology. A declined confirmation returns to editable email entry without creating an account.

Include a pending-account retry variant so repeated clicks do not visually imply repeated accounts. Use plain language such as “We couldn't send the code. Try again.” Do not display a fake success illustration during failure.

Show desktop and mobile. Modal or inline continuation is acceptable; select one and document keyboard dismissal/back behavior. Prototype confirmation → OTP and use-another-email → entry.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
