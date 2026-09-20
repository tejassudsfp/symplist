import { EmailConfigurationError } from "../errors.ts";
import type { EmailMessage, EmailSendResult, EmailTransport } from "../transport.ts";
import { assertValidMessage, redactAddress } from "./message.ts";

export interface LogTransportOptions {
  /** `EMAIL_DRIVER`; the log transport exists only for `log`. */
  readonly driver: string;
  /** `NODE_ENV`; production refuses the log transport (decision A7, §16.1). */
  readonly nodeEnv: string | undefined;
  /** Where summary lines go; defaults to `console.info`. */
  readonly write?: (line: string) => void;
}

/**
 * Development email transport (decision A7): prints a redacted one-line summary and, for OTP emails,
 * the code, so local sign-in works without Resend. It refuses to exist unless `EMAIL_DRIVER=log` and
 * `NODE_ENV` is not `production`, and it never prints subjects, bodies or full addresses.
 */
export function createLogEmailTransport(options: LogTransportOptions): EmailTransport {
  if (options.driver !== "log") {
    throw new EmailConfigurationError(
      "email.driver_refused",
      "The log email transport requires EMAIL_DRIVER=log",
    );
  }
  if (options.nodeEnv === "production" || process.env.NODE_ENV === "production") {
    throw new EmailConfigurationError(
      "email.driver_refused",
      "The log email transport is refused when NODE_ENV=production",
    );
  }
  const write = options.write ?? ((line: string) => console.info(line));
  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      if (process.env.NODE_ENV === "production") {
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
