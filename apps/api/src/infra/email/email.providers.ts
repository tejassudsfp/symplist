import type { Provider } from "@nestjs/common";
import {
  createLogEmailTransport,
  createResendEmailTransport,
  type EmailTransport,
  type EmailTransportLogEntry,
} from "@symplist/email";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";

/** Injection token for the api's {@link EmailTransport} (Resend, or the development log transport). */
export const EMAIL_TRANSPORT = "symplist:EMAIL_TRANSPORT";

/** Injection token for a transport that replaces the configured one (tests use a capture transport). */
export const EMAIL_TRANSPORT_OVERRIDE = "symplist:EMAIL_TRANSPORT_OVERRIDE";

function transportLog(logger: AppLogger) {
  const write = (level: "info" | "warn") => (entry: EmailTransportLogEntry) => {
    const { event, idempotencyKey: _key, ...fields } = entry;
    logger[level](event, fields);
  };
  return { info: write("info"), warn: write("warn") };
}

/** Selects Resend for `EMAIL_DRIVER=resend` and the log transport otherwise (§16.1). */
export function createApiEmailTransport(config: ApiConfig, logger: AppLogger): EmailTransport {
  if (config.EMAIL_DRIVER === "resend") {
    if (!config.RESEND_API_KEY) throw new Error("EMAIL_DRIVER=resend requires RESEND_API_KEY");
    return createResendEmailTransport({
      apiKey: config.RESEND_API_KEY,
      senders: {
        security: config.EMAIL_FROM_SECURITY,
        ...(config.EMAIL_FROM_REMINDERS ? { reminders: config.EMAIL_FROM_REMINDERS } : {}),
      },
      logger: transportLog(logger),
    });
  }
  return createLogEmailTransport({ driver: config.EMAIL_DRIVER, nodeEnv: config.NODE_ENV });
}

export const emailProviders: Provider[] = [
  {
    provide: EMAIL_TRANSPORT,
    useFactory: (config: ApiConfig, logger: AppLogger, override?: EmailTransport) =>
      override ?? createApiEmailTransport(config, logger),
    inject: [API_CONFIG, AppLogger, { token: EMAIL_TRANSPORT_OVERRIDE, optional: true }],
  },
];
