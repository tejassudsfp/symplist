# Administration — account access

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design an account list showing display name if available, verified email, verification state, beta access (Locked / Unlocked / Paused), onboarding state, grant source, and creation date. Filters should help find newly verified locked accounts. Do not expose user tasks, chats, documents, or vault entries.

Account detail shows admission history and actions: Unlock account, Relock access, Restore eligibility/access, and inspect the invite reference. Direct unlock requires an admin reason and creates an auditable grant; it does not generate or email an invite.

Show confirm-unlock, unlocked success, relock confirmation, saving/error, and a concurrently changed account state. Relock copy explains that new app access/work is blocked and ongoing work is stopped where possible, without promising reversal of external actions. An administratively relocked user cannot redeem another code to bypass it.

Distinguish an unverified pending registration from a verified locked account. Admin unlock must not itself verify the person's email. Do not add role promotion controls casually; admin bootstrap and role management are outside the ordinary beta admission flow.

Include an optional preview of campaign grant revocation listing affected accounts, with explicit scope confirmation. Do not reset invite usage when relocking users. Desktop and mobile detail must present the same safeguards without crowded action buttons.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.
