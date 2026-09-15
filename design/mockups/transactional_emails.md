# Transactional email templates

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design five restrained HTML/email mockups with plain-text equivalents: sign-in verification OTP, new-account verification OTP, vault-reset OTP, vault-key-reset notification, and task reminder. Use a simple default brand treatment that remains legible in email clients' light/dark rendering; do not assume the account's interactive theme can be faithfully rendered by every email client.

OTP emails show a clear purpose, a large copyable code, a configurable expiry phrase, and a brief “If you didn't request this, you can ignore it” message where appropriate. Signup verification must explicitly avoid suggesting beta admission: “Verify your email to continue. App access still requires a beta invite.”

Vault reset OTP states its distinct purpose and that it authorizes changing the vault key. The reset-complete notification reports the change and links to a configured account/help destination without embedding secret reset capabilities in a fabricated URL. Do not include vault values or recovery keys.

There is no automatic invite email template. The operator personally shares codes outside this signup flow. Do not design referral campaigns, upgrade emails, billing receipts, or payment reminders for beta.

Use symplist, MIT/open-source attribution only where natural, and Tejas Parthasarathi Sudarshan / tejassuds.com in a restrained footer if appropriate. All sender addresses and links must be configured placeholders; all codes are clearly fictional in design annotations. Show desktop email and narrow mobile email views, plus dark-client readability notes.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Task reminder email

Follow [reminder privacy and delivery semantics](../../docs/notes/files/15_deadlines_reminders_calendar.md). Default to a generic subject/body, due time with timezone, authenticated Open task link, and reminder-preferences link. Show a separate explicit-opt-in title preview variant and delayed-reminder wording. No Markdown/chat excerpts or Vault contents. Include plain-text/mobile/dark-client variants. Link visits never complete tasks; reminder opt-out leaves OTP and security messages active.
