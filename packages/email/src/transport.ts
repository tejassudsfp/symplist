/** Which configured sender an email uses: security mail (OTP, Vault reset) or reminders (§5.1, §12.3). */
export type EmailSenderKind = "security" | "reminders";

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
}

export interface EmailSendResult {
  /** The provider message id; null for the log transport. */
  readonly providerId: string | null;
}

/** Sends email through Resend or, in development only, the log transport (§16.1). */
export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
