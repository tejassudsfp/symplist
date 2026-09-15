# Onboarding — name

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the first step after account unlock. Ask “What should we call you?” with one labeled name input and Continue. Use Maya as sample input. A short welcome line is enough; avoid questionnaires about job role, company size, goals, or productivity style.

Show a small two-step progression if helpful: Your name → Connections. There is no payment step in beta and no forced theme selection. Explain neither infrastructure nor agent providers on this screen. The back action may return to an account menu, but must not re-lock the account or request another invite.

Required states: empty, entered, saving, save error, long name, and resumed partially completed onboarding. Name is required; preserve typed input on failure. If the user previously saved it, prefill it without a redundant welcome ceremony. Demonstrate keyboard submit and mobile input layout.

Use a restrained illustration only if it reinforces the theme. The central field and action should still be the unmistakable focus. Success advances to optional connectors. An interrupted flow resumes this step or the next appropriate step rather than restarting signup.

Prototype the successful step, retry after error, and return from connections with the name preserved. Show where display name will appear later in the profile menu.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
