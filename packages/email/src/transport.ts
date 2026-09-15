/** Which configured sender an email uses: security mail (OTP, Vault reset) or reminders (§5.1, §12.3). */
export type EmailSenderKind = "security" | "reminders";

/** Every template the email package renders. Used for redacted logs and provider tags, never content. */
export type EmailTemplateId =
  | "otp_sign_in"
  | "otp_signup"
  | "otp_vault_reset"
  | "otp_account_delete"
  | "vault_reset_notice"
  | "reminder";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /** Every template ships a plain-text version. */
  readonly text: string;
  readonly sender: EmailSenderKind;
  /** Provider idempotency key, for example `reminder/<occurrenceId>/email`. */
  readonly idempotencyKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The rendered template, for redacted logs and provider tags. */
  readonly template?: EmailTemplateId;
  /**
   * The one-time code carried by an OTP email. Only the development log transport prints it
   * (`EMAIL_DRIVER=log`, never in production, §16.1); every other transport ignores it.
   */
  readonly otp?: string;
}

export interface EmailSendResult {
  /** The provider message id; null for the log transport. */
  readonly providerId: string | null;
}

/** Sends email through Resend or, in development only, the log transport (§16.1). */
export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
