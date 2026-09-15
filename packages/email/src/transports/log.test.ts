import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailConfigurationError } from "../errors.ts";
import type { EmailMessage } from "../transport.ts";
import { createLogEmailTransport } from "./log.ts";

const otpMessage: EmailMessage = {
  to: "maya@example.com",
  subject: "Your symplist sign-in code",
  html: "<p>Enter this code: 482913</p>",
  text: "Enter this code: 482913 private body",
  sender: "security",
  idempotencyKey: "otp/login/0192f0a0-0000-7000-8000-000000000001",
  template: "otp_sign_in",
  otp: "482913",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("log transport", () => {
  it("prints a redacted summary with the OTP in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const lines: string[] = [];
    const transport = createLogEmailTransport({
      driver: "log",
      nodeEnv: "development",
      write: (line) => lines.push(line),
    });

    await expect(transport.send(otpMessage)).resolves.toEqual({ providerId: null });

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line.startsWith("[email:log] ")).toBe(true);
    expect(JSON.parse(line.slice("[email:log] ".length))).toEqual({
      template: "otp_sign_in",
      sender: "security",
      to: "m…@example.com",
      idempotencyKey: otpMessage.idempotencyKey,
      otp: "482913",
    });
    expect(line).not.toContain("maya@example.com");
    expect(line).not.toContain(otpMessage.subject);
    expect(line).not.toContain("private body");
  });

  it("prints no OTP for other templates and never the subject or body", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const lines: string[] = [];
    const transport = createLogEmailTransport({
      driver: "log",
      nodeEnv: "test",
      write: (line) => lines.push(line),
    });
    await transport.send({
      ...otpMessage,
      subject: "Reminder: Refresh my portfolio",
      text: "Refresh my portfolio",
      html: "<p>Refresh my portfolio</p>",
      sender: "reminders",
      template: "reminder",
      otp: undefined,
      idempotencyKey: "reminder/0192f0a0-0000-7000-8000-000000000301/email",
    });
    expect(lines[0]).not.toContain("otp");
    expect(lines[0]).not.toContain("Refresh my portfolio");
  });

  it("defaults to console.info", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await createLogEmailTransport({ driver: "log", nodeEnv: "development" }).send(otpMessage);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("refuses production by configuration and by environment", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() => createLogEmailTransport({ driver: "log", nodeEnv: "production" })).toThrow(
      EmailConfigurationError,
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createLogEmailTransport({ driver: "log", nodeEnv: "development" })).toThrow(
      EmailConfigurationError,
    );
  });

  it("refuses to send if the process switches to production after construction", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const lines: string[] = [];
    const transport = createLogEmailTransport({
      driver: "log",
      nodeEnv: "development",
      write: (line) => lines.push(line),
    });
    vi.stubEnv("NODE_ENV", "production");
    await expect(transport.send(otpMessage)).rejects.toMatchObject({
      code: "email.driver_refused",
    });
    expect(lines).toEqual([]);
  });

  it("refuses unless EMAIL_DRIVER=log", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => createLogEmailTransport({ driver: "resend", nodeEnv: "development" })).toThrow(
      /EMAIL_DRIVER=log/,
    );
  });
});
