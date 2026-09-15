import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { EmailValidationError } from "./errors.ts";
import {
  checkAppLink,
  checkReminderPreferencesLink,
  type EmailLinkConfig,
  type ResolvedEmailLinks,
  resolveEmailLinks,
} from "./links.ts";
import { checkTimeZone } from "./templates/format.ts";
import { OtpEmail, type OtpPurpose, otpCopy, otpPurposes } from "./templates/otp.tsx";
import { ReminderEmail, type ReminderEmailProps, reminderSubject } from "./templates/reminder.tsx";
import { VaultResetNoticeEmail, vaultResetNoticeSubject } from "./templates/vault-reset-notice.tsx";
import type { EmailMessage, EmailSenderKind, EmailTemplateId } from "./transport.ts";

/** A rendered email, ready to address and send. */
export interface RenderedEmail {
  readonly template: EmailTemplateId;
  readonly sender: EmailSenderKind;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Set only for OTP emails, for the development log transport. */
  readonly otp?: string;
}

function inputError(message: string): EmailValidationError {
  return new EmailValidationError("email.invalid_template_input", message);
}

async function renderBoth(element: ReactElement): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, {
      plainText: true,
      htmlToTextOptions: {
        wordwrap: false,
        selectors: [
          { selector: "img", format: "skip" },
          { selector: "[data-skip-in-text=true]", format: "skip" },
          {
            selector: "a",
            options: { hideLinkHrefIfSameAsText: true, linkBrackets: ["<", ">"] },
          },
          { selector: "h1", options: { uppercase: false } },
        ],
      },
    }),
  ]);
  return { html, text: `${text.trim()}\n` };
}

const otpTemplates: Record<OtpPurpose, EmailTemplateId> = {
  login: "otp_sign_in",
  signup: "otp_signup",
  vault_reset: "otp_vault_reset",
  account_delete: "otp_account_delete",
};

export interface OtpEmailInput {
  readonly purpose: OtpPurpose;
  readonly code: string;
  readonly expiresInMinutes: number;
}

/** Renders an OTP email from the security sender (§5.1). The subject and preview never contain the code. */
export async function renderOtpEmail(input: OtpEmailInput): Promise<RenderedEmail> {
  if (!otpPurposes.includes(input.purpose)) throw inputError("Unknown OTP purpose");
  if (!/^\d{4,10}$/.test(input.code)) throw inputError("An OTP code is 4-10 digits");
  if (
    !Number.isInteger(input.expiresInMinutes) ||
    input.expiresInMinutes < 1 ||
    input.expiresInMinutes > 1440
  ) {
    throw inputError("expiresInMinutes must be a whole number of minutes between 1 and 1440");
  }
  const { html, text } = await renderBoth(
    <OtpEmail
      purpose={input.purpose}
      code={input.code}
      expiresInMinutes={input.expiresInMinutes}
    />,
  );
  return {
    template: otpTemplates[input.purpose],
    sender: "security",
    subject: otpCopy(input.purpose, input.expiresInMinutes).subject,
    html,
    text,
    otp: input.code,
  };
}

export interface VaultResetNoticeEmailInput {
  readonly changedAt: number;
  readonly timeZone: string;
}

/** Email renderer bound to validated link configuration. */
export interface EmailRenderer {
  readonly links: ResolvedEmailLinks;
  otp(input: OtpEmailInput): Promise<RenderedEmail>;
  vaultResetNotice(input: VaultResetNoticeEmailInput): Promise<RenderedEmail>;
  reminder(input: ReminderEmailInput): Promise<RenderedEmail>;
}

export interface ReminderEmailInput extends ReminderEmailProps {
  /**
   * RFC 8058 one-click opt-out endpoint carrying the narrow `reminder-unsubscribe` token. When set,
   * `List-Unsubscribe` and `List-Unsubscribe-Post` headers are added.
   */
  readonly oneClickUnsubscribeUrl?: string;
}

/** Validates link configuration once and returns renderers for every template. */
export function createEmailRenderer(config: EmailLinkConfig): EmailRenderer {
  const links = resolveEmailLinks(config);
  return {
    links,
    otp: renderOtpEmail,
    async vaultResetNotice(input) {
      checkTimeZone(input.timeZone);
      const { html, text } = await renderBoth(
        <VaultResetNoticeEmail
          changedAt={input.changedAt}
          timeZone={input.timeZone}
          accountHelpUrl={links.accountHelpUrl}
        />,
      );
      return {
        template: "vault_reset_notice",
        sender: "security",
        subject: vaultResetNoticeSubject,
        html,
        text,
      };
    },
    async reminder(input) {
      const openTaskUrl = checkAppLink(input.openTaskUrl, links, "openTaskUrl");
      const preferencesUrl = checkReminderPreferencesLink(
        input.preferencesUrl,
        links,
        "preferencesUrl",
      );
      const oneClick =
        input.oneClickUnsubscribeUrl === undefined
          ? undefined
          : checkReminderPreferencesLink(
              input.oneClickUnsubscribeUrl,
              links,
              "oneClickUnsubscribeUrl",
            );
      const props: ReminderEmailProps = {
        due: input.due,
        preview: input.preview,
        openTaskUrl,
        preferencesUrl,
        ...(input.delayed === undefined ? {} : { delayed: input.delayed }),
      };
      const subject = reminderSubject(input.preview, input.delayed !== undefined);
      const { html, text } = await renderBoth(<ReminderEmail {...props} />);
      return {
        template: "reminder",
        sender: "reminders",
        subject,
        html,
        text,
        ...(oneClick === undefined
          ? {}
          : {
              headers: {
                "List-Unsubscribe": `<${oneClick}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }),
      };
    },
  };
}

/** Addresses a rendered email for a transport. */
export function toEmailMessage(
  rendered: RenderedEmail,
  envelope: { readonly to: string; readonly idempotencyKey: string },
): EmailMessage {
  return {
    to: envelope.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    sender: rendered.sender,
    idempotencyKey: envelope.idempotencyKey,
    template: rendered.template,
    ...(rendered.headers === undefined ? {} : { headers: rendered.headers }),
    ...(rendered.otp === undefined ? {} : { otp: rendered.otp }),
  };
}
