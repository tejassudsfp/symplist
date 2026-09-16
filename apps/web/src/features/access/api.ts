"use client";

import {
  type AccountDeletionAuthorizationResponse,
  type AccountDeletionResponse,
  type AdminAccount,
  type AdminAccountActionRequest,
  type AdminAccountDetail,
  type AdminAccountPage,
  type AdminEventDetail,
  type AdminEventPage,
  type AdminInvite,
  type AdminInviteDetail,
  type AdminInvitePage,
  type AuthLookupResponse,
  accountDeletionAuthorizationResponseSchema,
  accountDeletionResponseSchema,
  adminAccountDetailSchema,
  adminAccountPageSchema,
  adminAccountSchema,
  adminEventDetailSchema,
  adminEventPageSchema,
  adminInviteDetailSchema,
  adminInvitePageSchema,
  adminInviteSchema,
  authLookupResponseSchema,
  type CampaignRevocationConfirmRequest,
  type CampaignRevocationPreview,
  type CampaignRevocationResult,
  campaignRevocationPreviewSchema,
  campaignRevocationResultSchema,
  type GenerateInvitesRequest,
  type GenerateInvitesResponse,
  generateInvitesResponseSchema,
  type ListAccountsQuery,
  type ListActivityQuery,
  type ListInvitesQuery,
  logoutResponseSchema,
  type MeResponse,
  meResponseSchema,
  type OtpChallengeResponse,
  otpChallengeResponseSchema,
  type RedeemInviteResponse,
  redeemInviteResponseSchema,
} from "@symplist/contracts";
import { createContext, createElement, type ReactNode, useContext } from "react";
import { type ApiClient, getApiClient } from "@/lib/api";

/** The admin account actions (§5.4), each `POST /v1/admin/accounts/:id/<action>`. */
export type AdminAccountAction = "unlock" | "relock" | "restore-eligibility" | "restore-access";

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Every access route the web app calls (§5, decision AC1), typed with the contracts schemas. Screens
 * use this interface through `useAccessApi()`, so tests replace the whole transport with a fake.
 */
export interface AccessApi {
  lookup(email: string): Promise<AuthLookupResponse>;
  signup(email: string): Promise<OtpChallengeResponse>;
  sendLoginCode(email: string): Promise<OtpChallengeResponse>;
  verifyCode(challengeId: string, code: string): Promise<MeResponse>;
  logout(): Promise<void>;
  me(signal?: AbortSignal): Promise<MeResponse>;
  updateDisplayName(displayName: string): Promise<MeResponse>;
  completeOnboarding(): Promise<MeResponse>;
  redeem(code: string, idempotencyKey: string): Promise<RedeemInviteResponse>;
  sendDeletionCode(): Promise<OtpChallengeResponse>;
  verifyDeletionCode(
    challengeId: string,
    code: string,
  ): Promise<AccountDeletionAuthorizationResponse>;
  requestDeletion(
    authorizationId: string,
    idempotencyKey: string,
  ): Promise<AccountDeletionResponse>;
  listInvites(query: ListInvitesQuery, signal?: AbortSignal): Promise<AdminInvitePage>;
  inviteDetail(inviteId: string, signal?: AbortSignal): Promise<AdminInviteDetail>;
  generateInvites(
    request: GenerateInvitesRequest,
    idempotencyKey: string,
  ): Promise<GenerateInvitesResponse>;
  updateInviteCapacity(
    inviteId: string,
    body: { maxRedemptions: number; expectedVersion: number },
    idempotencyKey: string,
  ): Promise<AdminInvite>;
  extendInviteExpiry(
    inviteId: string,
    body: { expiresAt: number; expectedVersion: number },
    idempotencyKey: string,
  ): Promise<AdminInvite>;
  revokeInvite(
    inviteId: string,
    body: { expectedVersion: number },
    idempotencyKey: string,
  ): Promise<AdminInvite>;
  listAccounts(query: ListAccountsQuery, signal?: AbortSignal): Promise<AdminAccountPage>;
  accountDetail(userId: string, signal?: AbortSignal): Promise<AdminAccountDetail>;
  accountAction(
    userId: string,
    action: AdminAccountAction,
    body: AdminAccountActionRequest,
    idempotencyKey: string,
  ): Promise<AdminAccount>;
  previewCampaignRevocation(campaignId: string): Promise<CampaignRevocationPreview>;
  confirmCampaignRevocation(
    campaignId: string,
    body: CampaignRevocationConfirmRequest,
    idempotencyKey: string,
  ): Promise<CampaignRevocationResult>;
  listActivity(query: ListActivityQuery, signal?: AbortSignal): Promise<AdminEventPage>;
  activityDetail(eventId: string, signal?: AbortSignal): Promise<AdminEventDetail>;
}

function segment(id: string): string {
  return encodeURIComponent(id);
}

function queryOf(query: object): Query {
  const result: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function withSignal(signal: AbortSignal | undefined) {
  return signal ? { signal } : {};
}

/** The part of the browser API client the access routes use. */
export type AccessTransport = Pick<ApiClient, "get" | "post" | "put">;

/** The access routes over the browser API client (§5.3 route classes, §6.1 idempotency). */
export function createAccessApi(client: AccessTransport): AccessApi {
  return {
    lookup: (email) =>
      client.post("/v1/auth/lookup", {
        body: { email },
        csrf: "pre_session",
        schema: authLookupResponseSchema,
      }),
    signup: (email) =>
      client.post("/v1/auth/signup", {
        body: { email, consent: true },
        csrf: "pre_session",
        schema: otpChallengeResponseSchema,
      }),
    sendLoginCode: (email) =>
      client.post("/v1/auth/otp", {
        body: { email },
        csrf: "pre_session",
        schema: otpChallengeResponseSchema,
      }),
    verifyCode: (challengeId, code) =>
      client.post("/v1/auth/otp/verify", {
        body: { challengeId, code },
        csrf: "pre_session",
        schema: meResponseSchema,
      }),
    logout: async () => {
      await client.post("/v1/auth/logout", { schema: logoutResponseSchema });
    },
    me: (signal) => client.get("/v1/me", { schema: meResponseSchema, ...withSignal(signal) }),
    updateDisplayName: (displayName) =>
      client.put("/v1/me/name", { body: { displayName }, schema: meResponseSchema }),
    completeOnboarding: () =>
      client.post("/v1/me/onboarding/complete", { schema: meResponseSchema }),
    redeem: (code, idempotencyKey) =>
      client.post("/v1/access/redeem", {
        body: { code },
        idempotencyKey,
        schema: redeemInviteResponseSchema,
      }),
    sendDeletionCode: () =>
      client.post("/v1/account/deletion/otp", { schema: otpChallengeResponseSchema }),
    verifyDeletionCode: (challengeId, code) =>
      client.post("/v1/account/deletion/verify", {
        body: { challengeId, code },
        schema: accountDeletionAuthorizationResponseSchema,
      }),
    requestDeletion: (authorizationId, idempotencyKey) =>
      client.post("/v1/account/deletion", {
        body: { authorizationId },
        idempotencyKey,
        schema: accountDeletionResponseSchema,
      }),
    listInvites: (query, signal) =>
      client.get("/v1/admin/invites", {
        query: queryOf(query),
        schema: adminInvitePageSchema,
        ...withSignal(signal),
      }),
    inviteDetail: (inviteId, signal) =>
      client.get(`/v1/admin/invites/${segment(inviteId)}`, {
        schema: adminInviteDetailSchema,
        ...withSignal(signal),
      }),
    generateInvites: (request, idempotencyKey) =>
      client.post("/v1/admin/invites", {
        body: request,
        idempotencyKey,
        schema: generateInvitesResponseSchema,
      }),
    updateInviteCapacity: (inviteId, body, idempotencyKey) =>
      client.post(`/v1/admin/invites/${segment(inviteId)}/capacity`, {
        body,
        idempotencyKey,
        schema: adminInviteSchema,
      }),
    extendInviteExpiry: (inviteId, body, idempotencyKey) =>
      client.post(`/v1/admin/invites/${segment(inviteId)}/expiry`, {
        body,
        idempotencyKey,
        schema: adminInviteSchema,
      }),
    revokeInvite: (inviteId, body, idempotencyKey) =>
      client.post(`/v1/admin/invites/${segment(inviteId)}/revoke`, {
        body,
        idempotencyKey,
        schema: adminInviteSchema,
      }),
    listAccounts: (query, signal) =>
      client.get("/v1/admin/accounts", {
        query: queryOf(query),
        schema: adminAccountPageSchema,
        ...withSignal(signal),
      }),
    accountDetail: (userId, signal) =>
      client.get(`/v1/admin/accounts/${segment(userId)}`, {
        schema: adminAccountDetailSchema,
        ...withSignal(signal),
      }),
    accountAction: (userId, action, body, idempotencyKey) =>
      client.post(`/v1/admin/accounts/${segment(userId)}/${action}`, {
        body,
        idempotencyKey,
        schema: adminAccountSchema,
      }),
    previewCampaignRevocation: (campaignId) =>
      client.post(`/v1/admin/campaigns/${segment(campaignId)}/revocation/preview`, {
        schema: campaignRevocationPreviewSchema,
      }),
    confirmCampaignRevocation: (campaignId, body, idempotencyKey) =>
      client.post(`/v1/admin/campaigns/${segment(campaignId)}/revocation/confirm`, {
        body,
        idempotencyKey,
        schema: campaignRevocationResultSchema,
      }),
    listActivity: (query, signal) =>
      client.get("/v1/admin/activity", {
        query: queryOf(query),
        schema: adminEventPageSchema,
        ...withSignal(signal),
      }),
    activityDetail: (eventId, signal) =>
      client.get(`/v1/admin/activity/${segment(eventId)}`, {
        schema: adminEventDetailSchema,
        ...withSignal(signal),
      }),
  };
}

/** The app-wide access API over the shared browser client. Browser only. */
export function getAccessApi(): AccessApi {
  return lazySharedApi;
}

/** Drops the cached CSRF token of the shared client (sign-out, account switch). */
export function clearSharedCsrfToken(): void {
  try {
    getApiClient().clearCsrfToken();
  } catch {
    // Without a configured client there is no token to drop.
  }
}

const AccessApiContext = createContext<AccessApi | null>(null);

/** Supplies a fixed access API, for tests and previews. */
export function AccessApiProvider({ api, children }: { api: AccessApi; children: ReactNode }) {
  return createElement(AccessApiContext.Provider, { value: api }, children);
}

/**
 * The shared client, resolved on each call, so a build without public configuration fails the call
 * (a rejected promise the screen can show) instead of the render.
 */
const lazyTransport: AccessTransport = {
  get: async (path, options) => getApiClient().get(path, options),
  post: async (path, options) => getApiClient().post(path, options),
  put: async (path, options) => getApiClient().put(path, options),
};

const lazySharedApi: AccessApi = createAccessApi(lazyTransport);

/** The access API: the provided one, or the shared browser client. */
export function useAccessApi(): AccessApi {
  return useContext(AccessApiContext) ?? lazySharedApi;
}
