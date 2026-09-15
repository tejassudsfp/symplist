import type { PostHogConfig } from "posthog-js";
import { createPostHogConfig } from "./config.ts";
import {
  type AnalyticsEventProperties,
  type AnalyticsValidationFailure,
  type ClientAnalyticsEventName,
  validateAnalyticsEvent,
} from "./events.ts";

/** `users.analytics_consent` (§15). */
export type AnalyticsConsentState = "unset" | "granted" | "denied";

/**
 * Route prefixes that never load the analytics client (§15): auth and OTP, the beta gate, the Vault,
 * OAuth consent, and share-host artifact routes. `/connections/callback` is excluded too: its
 * address can carry connection attempt parameters and external account ids (note 17), which
 * posthog-js would otherwise keep in its local session state.
 */
export const excludedAnalyticsPathPrefixes: readonly string[] = [
  "/signin",
  "/access",
  "/vault",
  "/oauth",
  "/artifact",
  "/connections/callback",
];

export function isExcludedAnalyticsPath(pathname: string): boolean {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  return excludedAnalyticsPathPrefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** The posthog-js surface Symplist uses. */
export interface PostHogBrowserClient {
  __loaded: boolean;
  init(token: string, config?: Partial<PostHogConfig>): unknown;
  opt_in_capturing(options?: { captureEventName?: string | null | false }): void;
  opt_out_capturing(): void;
  identify(distinctId: string): void;
  capture(eventName: string, properties?: Record<string, unknown> | null): unknown;
  reset(): void;
}

export interface BrowserAnalyticsOptions {
  /** `ANALYTICS_ENABLED`; when false nothing loads and nothing is sent. */
  readonly enabled: boolean;
  /** `NEXT_PUBLIC_POSTHOG_KEY`; when absent nothing loads and nothing is sent. */
  readonly projectKey: string | undefined;
  /** `NEXT_PUBLIC_POSTHOG_HOST`; defaults to PostHog US cloud. */
  readonly apiHost?: string;
  /** Loads posthog-js. Called only after consent is granted; defaults to a dynamic import. */
  readonly loadPostHog?: () => Promise<PostHogBrowserClient>;
  /** The current pathname; defaults to `window.location.pathname`. */
  readonly currentPath?: () => string;
  /** Storages cleaned on withdrawal; default to the window's storages when available. */
  readonly storages?: () => ReadonlyArray<Storage>;
}

export type ApplyConsentOutcome =
  | { readonly status: "active" }
  | {
      readonly status: "inactive";
      readonly reason:
        | "disabled"
        | "consent_not_granted"
        | "excluded_route"
        | "missing_identity"
        | "load_failed";
    };

export type TrackOutcome =
  | { readonly status: "sent" }
  | {
      readonly status: "refused";
      readonly reason:
        | "disabled"
        | "consent_not_granted"
        | "excluded_route"
        | "not_loaded"
        | "client_error"
        | AnalyticsValidationFailure;
    };

export interface BrowserAnalytics {
  /**
   * Applies the stored consent read from the api after sign-in (§15). Only `granted` loads
   * posthog-js, and only outside excluded routes; any other state withdraws a loaded client.
   */
  applyConsent(input: {
    readonly consent: AnalyticsConsentState;
    readonly analyticsId: string | null;
  }): Promise<ApplyConsentOutcome>;
  /** Sends an allowlisted client event. Never throws and never queues refused events. */
  track<Name extends ClientAnalyticsEventName>(
    name: Name,
    properties: AnalyticsEventProperties<Name>,
  ): TrackOutcome;
  /** Withdrawal (§15): `opt_out_capturing()`, `reset()`, then removes `ph_*` storage keys. */
  withdraw(): Promise<void>;
  /**
   * Logout (§15): `reset()` without opting in again, then removes PostHog's stored identity, even
   * when this page never loaded posthog-js (for example sign-out from the beta gate), so the next
   * account on the device never inherits it. Consent is re-applied after sign-in.
   */
  logout(): Promise<void>;
}

const defaultLoader = async (): Promise<PostHogBrowserClient> =>
  (await import("posthog-js")).posthog;

function defaultPath(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

function defaultStorages(): ReadonlyArray<Storage> {
  if (typeof window === "undefined") return [];
  const storages: Storage[] = [];
  for (const read of [() => window.sessionStorage, () => window.localStorage]) {
    try {
      storages.push(read());
    } catch {
      // Storage access can throw when site data is blocked; there is nothing to clean then.
    }
  }
  return storages;
}

/** Removes PostHog's `ph_*` keys and its stored opt-in/out choice. */
export function removePostHogStorageKeys(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && (key.startsWith("ph_") || key.startsWith("__ph_opt_in_out_"))) {
      keys.push(key);
    }
  }
  for (const key of keys) storage.removeItem(key);
}

/** The browser analytics controller: consent-gated loading and the typed `track()` wrapper. */
export function createBrowserAnalytics(options: BrowserAnalyticsOptions): BrowserAnalytics {
  const loadPostHog = options.loadPostHog ?? defaultLoader;
  const currentPath = options.currentPath ?? defaultPath;
  const storages = options.storages ?? defaultStorages;
  const enabled = options.enabled && Boolean(options.projectKey);

  let client: PostHogBrowserClient | null = null;
  let active = false;
  /** The analytics id the loaded client is identified as, to reset before another account. */
  let identified: string | null = null;
  let consent: AnalyticsConsentState = "unset";
  let chain: Promise<unknown> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const cleanStorages = () => {
    for (const storage of storages()) {
      try {
        removePostHogStorageKeys(storage);
      } catch {
        // Ignore storages that refuse access.
      }
    }
  };

  /** Stops capture on a loaded client and always clears PostHog's local state. */
  const deactivate = (withdrawn: boolean) => {
    if (client !== null) {
      try {
        if (withdrawn) client.opt_out_capturing();
        client.reset();
      } catch {
        // Analytics failures never block the app.
      }
    }
    active = false;
    identified = null;
    cleanStorages();
  };

  return {
    applyConsent(input) {
      return serialize(async (): Promise<ApplyConsentOutcome> => {
        consent = input.consent;
        if (!enabled) return { status: "inactive", reason: "disabled" };
        if (input.consent !== "granted") {
          // A stored denial also clears state left on this device by an earlier session, so an
          // opt-out made elsewhere is respected here too (note 17).
          if (client !== null || input.consent === "denied") {
            deactivate(input.consent === "denied");
          }
          return { status: "inactive", reason: "consent_not_granted" };
        }
        if (isExcludedAnalyticsPath(currentPath())) {
          return { status: "inactive", reason: "excluded_route" };
        }
        if (input.analyticsId === null || input.analyticsId === "") {
          return { status: "inactive", reason: "missing_identity" };
        }
        try {
          client ??= await loadPostHog();
          if (!client.__loaded) {
            client.init(
              options.projectKey ?? "",
              createPostHogConfig({ ...(options.apiHost ? { apiHost: options.apiHost } : {}) }),
            );
          }
          if (identified !== null && identified !== input.analyticsId) {
            // Another account on the same page: reset identity first (research C3).
            client.reset();
          }
          client.opt_in_capturing({ captureEventName: false });
          client.identify(input.analyticsId);
          identified = input.analyticsId;
          active = true;
          return { status: "active" };
        } catch {
          active = false;
          return { status: "inactive", reason: "load_failed" };
        }
      });
    },

    track(name, properties) {
      if (!enabled) return { status: "refused", reason: "disabled" };
      if (consent !== "granted") return { status: "refused", reason: "consent_not_granted" };
      if (isExcludedAnalyticsPath(currentPath())) {
        return { status: "refused", reason: "excluded_route" };
      }
      const validation = validateAnalyticsEvent("client", name, properties);
      if (!validation.ok) return { status: "refused", reason: validation.reason };
      if (!active || client === null) return { status: "refused", reason: "not_loaded" };
      try {
        client.capture(validation.event, { ...validation.properties });
        return { status: "sent" };
      } catch {
        return { status: "refused", reason: "client_error" };
      }
    },

    withdraw() {
      return serialize(async () => {
        consent = "denied";
        deactivate(true);
      });
    },

    logout() {
      return serialize(async () => {
        consent = "unset";
        deactivate(false);
      });
    },
  };
}
