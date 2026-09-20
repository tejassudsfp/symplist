import { randomUUID } from "node:crypto";
import type {
  GenerateInvitesRequest,
  MeResponse,
  OtpChallengeResponse,
  OtpPurpose,
} from "@symplist/contracts";
import type { EmailMessage } from "@symplist/email";
import { expect } from "vitest";
import type { TestApp, TestResponse, TestSession } from "../harness.ts";

/**
 * Helpers for the access feature's api tests (`apps/api/src/modules/access/*.test.ts`): drive the
 * real sign-in, signup, invite and admin routes over HTTP on a booted test app.
 */

export const idempotencyKey = (): string => randomUUID();

/** The latest captured OTP email to an address for a purpose. */
export function lastOtpMessage(app: TestApp, email: string, purpose: OtpPurpose): EmailMessage {
  const template = {
    login: "otp_sign_in",
    signup: "otp_signup",
    vault_reset: "otp_vault_reset",
    account_delete: "otp_account_delete",
  }[purpose];
  const message = [...app.email.messages]
    .reverse()
    .find((candidate) => candidate.to === email && candidate.template === template);
  if (!message?.otp) throw new Error(`No ${purpose} code was sent to the address`);
  return message;
}

/** A different code of the same length that is certainly wrong. */
export function wrongCode(code: string): string {
  return code
    .split("")
    .map((digit) => String((Number(digit) + 1) % 10))
    .join("");
}

/** The raw `Set-Cookie` headers of a response. */
export function setCookies(response: TestResponse): string[] {
  return response.headers.getSetCookie();
}

/** The session a verify response signed in, as the harness's `TestSession`. */
export async function sessionFromResponse(
  app: TestApp,
  response: TestResponse,
): Promise<TestSession> {
  const name = app.sessionCookieName;
  const header = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) throw new Error("The response set no session cookie");
  const token = header.slice(name.length + 1).split(";")[0] ?? "";
  const resolved = await app.sessions.store.resolve(token, app.clock.now());
  if (!resolved) throw new Error("The session cookie does not resolve");
  return {
    userId: resolved.session.userId,
    sessionId: resolved.session.id,
    token,
    cookie: `${name}=${token}`,
    csrf: app.sessions.csrfToken(resolved.session.id),
  };
}

export async function sendLoginCode(app: TestApp, email: string): Promise<OtpChallengeResponse> {
  const response = await app.post("/v1/auth/otp", { csrf: "1", body: { email } });
  expect(response.status, response.text).toBe(201);
  return response.json<OtpChallengeResponse>();
}

export async function signupCode(app: TestApp, email: string): Promise<OtpChallengeResponse> {
  const response = await app.post("/v1/auth/signup", { csrf: "1", body: { email, consent: true } });
  expect(response.status, response.text).toBe(201);
  return response.json<OtpChallengeResponse>();
}

export function verifyCode(app: TestApp, challengeId: string, code: string): Promise<TestResponse> {
  return app.post("/v1/auth/otp/verify", { csrf: "1", body: { challengeId, code } });
}

/** Signs up a new address through the real routes and returns its session and profile. */
export async function signUp(
  app: TestApp,
  email = `new.${randomUUID().slice(0, 8)}@example.test`,
): Promise<{ readonly session: TestSession; readonly me: MeResponse; readonly email: string }> {
  const challenge = await signupCode(app, email);
  const code = lastOtpMessage(app, email, "signup").otp ?? "";
  const response = await verifyCode(app, challenge.challengeId, code);
  expect(response.status, response.text).toBe(200);
  return {
    session: await sessionFromResponse(app, response),
    me: response.json<MeResponse>(),
    email,
  };
}

/** Signs in an existing verified address through the real routes. */
export async function signInWithCode(
  app: TestApp,
  email: string,
): Promise<{ readonly session: TestSession; readonly me: MeResponse }> {
  const challenge = await sendLoginCode(app, email);
  const code = lastOtpMessage(app, email, "login").otp ?? "";
  const response = await verifyCode(app, challenge.challengeId, code);
  expect(response.status, response.text).toBe(200);
  return { session: await sessionFromResponse(app, response), me: response.json<MeResponse>() };
}

/** Generates invites as an administrator and returns the minting response body. */
export async function generateInvites(
  app: TestApp,
  admin: TestSession,
  request: Partial<GenerateInvitesRequest> = {},
  key = idempotencyKey(),
): Promise<{
  readonly campaignId: string;
  readonly invites: { id: string; hint: string; version: number; status: string }[];
  readonly codes: string[];
}> {
  const response = await app.post("/v1/admin/invites", {
    session: admin,
    idempotencyKey: key,
    body: {
      mode: "independent",
      count: 1,
      maxRedemptions: 1,
      expiresAt: app.clock.now() + 7 * 24 * 60 * 60 * 1000,
      ...request,
    },
  });
  expect(response.status, response.text).toBe(201);
  return response.json();
}

export function redeem(
  app: TestApp,
  session: TestSession,
  code: string,
  key = idempotencyKey(),
): Promise<TestResponse> {
  return app.post("/v1/access/redeem", { session, idempotencyKey: key, body: { code } });
}

export function adminAction(
  app: TestApp,
  admin: TestSession,
  userId: string,
  action: "unlock" | "relock" | "restore-eligibility" | "restore-access",
  body: { reason: string; expectedGeneration: number },
  key = idempotencyKey(),
): Promise<TestResponse> {
  return app.post(`/v1/admin/accounts/${userId}/${action}`, {
    session: admin,
    idempotencyKey: key,
    body,
  });
}

/** An error envelope's code. */
export function errorCode(response: TestResponse): string | undefined {
  try {
    return response.json<{ error?: { code?: string } }>().error?.code;
  } catch {
    return undefined;
  }
}
