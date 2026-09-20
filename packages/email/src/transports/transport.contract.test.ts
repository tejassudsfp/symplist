import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
// The email package cannot depend on @symplist/testing (which depends on it), so the shared suite and
// the fake Resend API are imported by path, as the db and storage packages do (decision C3-6).
import { describeEmailTransportContract } from "../../../testing/src/contracts/email/index.ts";
import { FakeResend } from "../../../testing/src/fakes/resend.ts";
import { createCaptureEmailTransport } from "./capture.ts";
import { createLogEmailTransport } from "./log.ts";
import { createResendEmailTransport } from "./resend.ts";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describeEmailTransportContract("Resend over the fake Resend API", () => {
  // A throwaway key generated per target; never a real credential.
  const apiKey = `re_test_${randomUUID()}`;
  const resend = new FakeResend({ apiKey });
  const logs: string[] = [];
  const transport = createResendEmailTransport({
    apiKey,
    senders: {
      security: "symplist <security@mail.symplist.example>",
      reminders: "symplist reminders <reminders@mail.symplist.example>",
    },
    fetch: resend.fetch,
    now: () => resend.clock.now(),
    logger: {
      info: (entry) => logs.push(JSON.stringify(entry)),
      warn: (entry) => logs.push(JSON.stringify(entry)),
    },
  });
  return {
    transport,
    kind: "provider",
    deliveries: () => resend.emails.length,
    logs: () => logs,
  };
});

describeEmailTransportContract("capture transport", () => {
  const transport = createCaptureEmailTransport();
  return {
    transport,
    kind: "provider",
    deliveries: () => transport.delivered().length,
    logs: () => [],
  };
});

describeEmailTransportContract("development log transport", () => {
  const lines: string[] = [];
  const transport = createLogEmailTransport({
    driver: "log",
    nodeEnv: "development",
    write: (line) => lines.push(line),
  });
  return { transport, kind: "log", deliveries: () => lines.length, logs: () => lines };
});
