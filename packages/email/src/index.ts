export * from "./errors.ts";
export * from "./idempotency.ts";
export {
  checkAppLink,
  checkReminderPreferencesLink,
  type EmailLinkConfig,
  type ResolvedEmailLinks,
  resolveEmailLinks,
} from "./links.ts";
export {
  createEmailRenderer,
  type EmailRenderer,
  type OtpEmailInput,
  type ReminderEmailInput,
  type RenderedEmail,
  renderOtpEmail,
  toEmailMessage,
  type VaultResetNoticeEmailInput,
} from "./render.tsx";
export { type OtpPurpose, otpPurposes } from "./templates/otp.tsx";
export type { ReminderDue, ReminderPreview } from "./templates/reminder.tsx";
export { emailColors, emailContrastPairs } from "./templates/theme.ts";
export type * from "./transport.ts";
export { type CaptureEmailTransport, createCaptureEmailTransport } from "./transports/capture.ts";
export { createLogEmailTransport, type LogTransportOptions } from "./transports/log.ts";
export { assertValidMessage, redactAddress } from "./transports/message.ts";
export {
  createResendEmailTransport,
  type EmailFetch,
  type EmailSenders,
  type EmailTransportLogEntry,
  type EmailTransportLogger,
  mapResendError,
  parseRetryAfter,
  type ResendTransportOptions,
  resendDefaultBaseUrl,
  resendHeaderNames,
} from "./transports/resend.ts";
