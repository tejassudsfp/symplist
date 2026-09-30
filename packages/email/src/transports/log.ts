import { EmailConfigurationError } from "../errors.ts";
import type { EmailMessage, EmailSendResult, EmailTransport } from "../transport.ts";
import { assertValidMessage, redactAddress } from "./message.ts";

export interface LogTransportOptions {
  /** `EMAIL_DRIVER`; the log transport exists only for `log`. */
  readonly driver: string;
  /** `NODE_ENV`; production refuses the log transport (decision A7, §16.1). */
  readonly nodeEnv: string | undefined;
  /**
   * Declares that this process is a single-user local install — the Symplist desktop app offline
   * (note 18, `DEPLOYMENT=local`).
   *
   * The production refusal below is a different concern from the db and storage ones, and worth stating
   * separately: printing an OTP to a log rather than sending it would, on a hosted service, hand a
   * sign-in code to whoever can read the logs and leave a real user waiting for mail that never comes.
   *
   * On a local install neither half applies. There is one account, it belongs to the person at the
   * keyboard, they never receive an OTP — `POST /v1/auth/local` is how they sign in — and the log is
   * their own machine's. Mail genuinely cannot be sent, because there is no Resend key and possibly no
   * network, so a transport that says so in the log is the honest one rather than a stand-in for a real
   * one. It still has to be declared, so the guard keeps protecting the deployment it was written for.
   */
  readonly singleUserInstall?: boolean;
  /** Where summary lines go; defaults to `console.info`. */
  readonly write?: (line: string) => void;
}

/**
 * Development email transport (decision A7): prints a redacted one-line summary and, for OTP emails,
 * the code, so local sign-in works without Resend. It refuses to exist unless `EMAIL_DRIVER=log` and
 * `NODE_ENV` is not `production` — or the caller declares a single-user local install, for which it is
 * the only honest transport. It never prints subjects, bodies or full addresses.
 */
export function createLogEmailTransport(options: LogTransportOptions): EmailTransport {
  if (options.driver !== "log") {
    throw new EmailConfigurationError(
      "email.driver_refused",
      "The log email transport requires EMAIL_DRIVER=log",
    );
  }
  const singleUser = options.singleUserInstall === true;
  if (!singleUser && (options.nodeEnv === "production" || process.env.NODE_ENV === "production")) {
    throw new EmailConfigurationError(
      "email.driver_refused",
      "The log email transport is refused when NODE_ENV=production; a single-user local install must " +
        "say so with singleUserInstall",
    );
  }
  const write = options.write ?? ((line: string) => console.info(line));
  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      // Re-checked at send time, not only at construction: `NODE_ENV` can be mutated in-process, and a
      // transport built in development must not start printing codes if it later looks like production.
      if (!singleUser && process.env.NODE_ENV === "production") {
        throw new EmailConfigurationError(
          "email.driver_refused",
          "The log email transport is refused when NODE_ENV=production",
        );
      }
      assertValidMessage(message);
      const summary = {
        template: message.template ?? null,
        sender: message.sender,
        to: redactAddress(message.to),
        idempotencyKey: message.idempotencyKey,
        ...(message.otp === undefined ? {} : { otp: message.otp }),
      };
      write(`[email:log] ${JSON.stringify(summary)}`);
      return { providerId: null };
    },
  };
}
