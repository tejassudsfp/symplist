import type { AccessState, MeResponse } from "@symplist/contracts";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { AccessApi } from "./api.ts";
import { AccessApiProvider } from "./api.ts";
import { SessionProvider } from "./session.tsx";
import { SessionStore } from "./session-store.ts";

/*
 * Shared support for the access feature's component tests: the Maya identity from the sample dataset,
 * a fake of every access route, and a render helper that mounts a screen inside a resolved session.
 */

export const mayaUserId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
export const mayaEmail = "maya@example.com";

export const admittedAccess: AccessState = {
  emailVerifiedAt: Date.UTC(2026, 8, 1, 9),
  betaState: "unlocked",
  suspendedAt: null,
  onboardingStep: "done",
  role: "member",
  accessGeneration: 2,
  accessEpoch: 0,
  deletionState: "none",
};

export const lockedAccess: AccessState = {
  ...admittedAccess,
  betaState: "locked",
  onboardingStep: "name",
  accessGeneration: 1,
};

export const pausedAccess: AccessState = { ...admittedAccess, betaState: "relocked" };

/** The `GET /v1/me` body for Maya, with any part replaced. */
export function mayaMe(overrides: Partial<MeResponse> = {}): MeResponse {
  const access = overrides.access ?? admittedAccess;
  const destination =
    overrides.destination ??
    (access.betaState === "relocked" || access.suspendedAt !== null
      ? "paused"
      : access.betaState === "unlocked"
        ? access.onboardingStep === "done"
          ? "app"
          : "onboarding"
        : "beta_gate");
  return {
    user: {
      id: mayaUserId as MeResponse["user"]["id"],
      email: mayaEmail,
      displayName: overrides.user?.displayName ?? "Maya Rao",
      role: overrides.user?.role ?? "member",
      ...(overrides.user ?? {}),
    },
    access,
    destination,
    betaAccessRequired: overrides.betaAccessRequired ?? true,
  };
}

function unimplemented(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} was called but not stubbed in this test`);
  });
}

/** A fake of every access route; each test stubs only the calls its screen makes. */
export function createFakeAccessApi(overrides: Partial<AccessApi> = {}): AccessApi {
  const base = {
    lookup: unimplemented("lookup"),
    signup: unimplemented("signup"),
    sendLoginCode: unimplemented("sendLoginCode"),
    verifyCode: unimplemented("verifyCode"),
    logout: unimplemented("logout"),
    me: unimplemented("me"),
    updateDisplayName: unimplemented("updateDisplayName"),
    completeOnboarding: unimplemented("completeOnboarding"),
    redeem: unimplemented("redeem"),
    sendDeletionCode: unimplemented("sendDeletionCode"),
    verifyDeletionCode: unimplemented("verifyDeletionCode"),
    requestDeletion: unimplemented("requestDeletion"),
    listInvites: unimplemented("listInvites"),
    inviteDetail: unimplemented("inviteDetail"),
    generateInvites: unimplemented("generateInvites"),
    updateInviteCapacity: unimplemented("updateInviteCapacity"),
    extendInviteExpiry: unimplemented("extendInviteExpiry"),
    revokeInvite: unimplemented("revokeInvite"),
    listAccounts: unimplemented("listAccounts"),
    accountDetail: unimplemented("accountDetail"),
    accountAction: unimplemented("accountAction"),
    previewCampaignRevocation: unimplemented("previewCampaignRevocation"),
    confirmCampaignRevocation: unimplemented("confirmCampaignRevocation"),
    listActivity: unimplemented("listActivity"),
    activityDetail: unimplemented("activityDetail"),
  } as unknown as AccessApi;
  return { ...base, ...overrides };
}

/** One of the api's error answers (§6), as the browser client parses it. */
export function accessApiError(
  code: string,
  status: number,
  options: { readonly retryAfterSeconds?: number; readonly details?: Record<string, unknown> } = {},
): ApiError {
  const details = {
    ...(options.details ?? {}),
    ...(options.retryAfterSeconds === undefined ? {} : { retryAfter: options.retryAfterSeconds }),
  };
  return new ApiError({
    status,
    code,
    message: "refused",
    requestId: "test-request",
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(options.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
  });
}

/** The api's answer for a request without a live session (§5.4). */
export function signedOutError(): ApiError {
  return new ApiError({
    status: 401,
    code: "auth.session_required",
    message: "Sign in to continue",
    requestId: "test-request",
  });
}

export interface RenderAccessOptions {
  readonly api?: AccessApi;
  /** The identity the session resolves to; omit for a session that is still loading. */
  readonly me?: MeResponse | null;
  readonly store?: SessionStore;
}

export interface RenderAccessResult extends RenderResult {
  readonly api: AccessApi;
  readonly store: SessionStore;
}

/** Renders a screen inside a resolved session and a fake access API. */
export function renderAccess(
  ui: ReactElement,
  options: RenderAccessOptions = {},
): RenderAccessResult {
  const api = options.api ?? createFakeAccessApi();
  const store =
    options.store ??
    new SessionStore({
      me: async () => {
        if (options.me) return options.me;
        throw signedOutError();
      },
    });
  if (options.me) store.setMe(options.me);
  const result = render(
    <AccessApiProvider api={api}>
      <SessionProvider store={store}>{ui}</SessionProvider>
    </AccessApiProvider>,
  );
  return { ...result, api, store };
}

export interface NavigationStub {
  readonly assign: ReturnType<typeof vi.fn>;
  readonly replace: ReturnType<typeof vi.fn>;
  /** Moves the stubbed address without a navigation. */
  setPath(path: string): void;
  restore(): void;
}

/**
 * Replaces `window.location` with a stub, because jsdom refuses real navigations. Screens that leave
 * an analytics-excluded route group use full document navigation (§15), which lands here.
 */
export function stubNavigation(initialPath = "/now"): NavigationStub {
  const original = window.location;
  const assign = vi.fn();
  const replace = vi.fn();
  const state = { url: new URL(initialPath, "http://localhost:3000") };
  const location = {
    get href() {
      return state.url.href;
    },
    get origin() {
      return state.url.origin;
    },
    get protocol() {
      return state.url.protocol;
    },
    get pathname() {
      return state.url.pathname;
    },
    get search() {
      return state.url.search;
    },
    get hash() {
      return state.url.hash;
    },
    assign,
    replace,
    reload: vi.fn(),
    toString: () => state.url.href,
  };
  Object.defineProperty(window, "location", { configurable: true, value: location });
  return {
    assign,
    replace,
    setPath: (path) => {
      state.url = new URL(path, "http://localhost:3000");
    },
    restore: () => {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Administration fixtures
 * --------------------------------------------------------------------------------------------- */

const campaignId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0ec001";
export const inviteId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e1001";

/** One invite as the administration routes return it. */
export function adminInviteFixture(
  overrides: Partial<import("@symplist/contracts").AdminInvite> = {},
): import("@symplist/contracts").AdminInvite {
  return {
    id: inviteId as import("@symplist/contracts").AdminInvite["id"],
    campaignId,
    mode: "independent",
    label: "Friends — September",
    hint: "WXYZ",
    status: "active",
    used: 1,
    maxRedemptions: 5,
    remaining: 4,
    boundEmail: null,
    expiresAt: Date.UTC(2026, 8, 30, 12),
    createdAt: Date.UTC(2026, 8, 1, 12),
    createdBy: mayaUserId,
    revokedAt: null,
    version: 3,
    ...overrides,
  } as import("@symplist/contracts").AdminInvite;
}

/** One account row as the administration routes return it. */
export function adminAccountFixture(
  overrides: Partial<import("@symplist/contracts").AdminAccount> = {},
): import("@symplist/contracts").AdminAccount {
  return {
    id: mayaUserId as import("@symplist/contracts").AdminAccount["id"],
    email: mayaEmail,
    displayName: "Maya Rao",
    emailVerifiedAt: Date.UTC(2026, 8, 1, 9),
    betaState: "unlocked",
    suspendedAt: null,
    onboardingStep: "done",
    role: "member",
    deletionState: "none",
    grantSource: "invite",
    createdAt: Date.UTC(2026, 8, 1, 8),
    accessGeneration: 2,
    accessEpoch: 0,
    ...overrides,
  } as import("@symplist/contracts").AdminAccount;
}

/** One audit event as the activity route returns it. */
export function adminEventFixture(
  overrides: Partial<import("@symplist/contracts").AdminEvent> = {},
): import("@symplist/contracts").AdminEvent {
  return {
    id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0ee001",
    createdAt: Date.UTC(2026, 8, 2, 10),
    actor: { kind: "user", id: mayaUserId, email: mayaEmail },
    action: "invite_redeemed",
    target: { kind: "invite", id: inviteId, label: "WXYZ" },
    before: null,
    after: null,
    hasReason: false,
    campaign: { id: campaignId, label: "Friends — September" },
    ...overrides,
  } as import("@symplist/contracts").AdminEvent;
}

export const campaignIdFixture = campaignId;
