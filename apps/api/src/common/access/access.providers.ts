import { Inject, Injectable, Optional, type Provider } from "@nestjs/common";
import {
  D1AccessService,
  type RestrictionCommitted,
  type RestrictionEffect,
} from "@symplist/core/access";
import {
  type AccountDeletionEffect,
  AccountDeletionService,
  AccountKeyStore,
} from "@symplist/core/account";
import { IdempotencyStore } from "@symplist/core/idempotency";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { SessionService } from "../auth/session.service.ts";
import { IDEMPOTENCY_STORE } from "../idempotency/idempotency.interceptor.ts";
import { AppLogger } from "../logging/logger.ts";
import {
  REALTIME_ACCESS_NOTIFIER,
  type RealtimeAccessNotifier,
  RUN_CANCELLER,
  type RunCanceller,
} from "../seams.ts";

/** Injection token for `core/access`'s {@link D1AccessService} with the api's post-commit effects. */
export const ACCESS_SERVICE = "symplist:ACCESS_SERVICE";

/** Injection token for the {@link AccountKeyStore}. */
export const ACCOUNT_KEYS = "symplist:ACCOUNT_KEYS";

/** Injection token for the {@link AccountDeletionService} (§5.6). */
export const ACCOUNT_DELETION = "symplist:ACCOUNT_DELETION";

/**
 * Injection token for extra account deletion effects (for example the PostHog person deletion
 * request), provided as an array by the feature that owns them.
 */
export const ACCOUNT_DELETION_EFFECTS = "symplist:ACCOUNT_DELETION_EFFECTS";

/**
 * Post-commit restriction effects that feature modules own (§5.5: "evicts access, grant and search
 * caches"), such as dropping a user's decrypted search index or cached grants. Features register them
 * from `onModuleInit`; they run after this process's access cache eviction and before sockets close,
 * in registration order, each failure logged and never rethrown. Account deletion runs them too,
 * because it runs every restriction effect after its batch (§5.6).
 */
@Injectable()
export class RestrictionEffectRegistry {
  private readonly effects = new Map<string, RestrictionEffect>();

  register(effect: RestrictionEffect): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(effect.name)) {
      throw new Error("Restriction effect names are lower-case identifiers");
    }
    if (this.effects.has(effect.name)) {
      throw new Error(`A restriction effect named ${effect.name} is already registered`);
    }
    this.effects.set(effect.name, effect);
  }

  registered(): readonly RestrictionEffect[] {
    return [...this.effects.values()];
  }
}

/**
 * The api's post-commit restriction effects in order (§5.5): evict this process's access caches, run
 * the feature cache evictions registered in {@link RestrictionEffectRegistry}, close sockets and
 * publish `access.changed` through the gateway, and cancel the user's runs.
 */
@Injectable()
export class RestrictionEffects {
  constructor(
    private readonly sessions: SessionService,
    private readonly registry: RestrictionEffectRegistry,
    private readonly logger: AppLogger,
    @Optional()
    @Inject(REALTIME_ACCESS_NOTIFIER)
    private readonly realtime?: RealtimeAccessNotifier,
    @Optional() @Inject(RUN_CANCELLER) private readonly runs?: RunCanceller,
  ) {}

  list(): readonly RestrictionEffect[] {
    const effects: RestrictionEffect[] = [
      {
        name: "access_cache_eviction",
        afterCommit: async (event: RestrictionCommitted) => {
          this.sessions.evictUser(event.userId, event.accessGeneration);
        },
      },
      {
        // Features register after this list is built, so the registry is read at each commit.
        name: "feature_cache_eviction",
        afterCommit: async (event: RestrictionCommitted) => {
          for (const effect of this.registry.registered()) {
            try {
              await effect.afterCommit(event);
            } catch (error) {
              this.logger.warn("access.restriction_effect_failed", { effect: effect.name, error });
            }
          }
        },
      },
    ];
    const { realtime, runs } = this;
    if (realtime) {
      effects.push({
        name: "realtime_access_restricted",
        afterCommit: (event) =>
          realtime.accessRestricted({
            userId: event.userId,
            reason: event.reason,
            accessGeneration: event.accessGeneration,
          }),
      });
    }
    if (runs) {
      effects.push({
        name: "run_cancellation",
        afterCommit: (event) =>
          runs.cancelRestrictedRuns({
            userId: event.userId,
            accessGeneration: event.accessGeneration,
          }),
      });
    }
    return effects;
  }
}

export const accessProviders: Provider[] = [
  RestrictionEffectRegistry,
  RestrictionEffects,
  {
    provide: ACCESS_SERVICE,
    useFactory: (db: DbClient, config: ApiConfig, effects: RestrictionEffects, logger: AppLogger) =>
      new D1AccessService({
        db,
        policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
        effects: effects.list(),
        onEffectError: (effect, error) =>
          logger.warn("access.restriction_effect_failed", { effect, error }),
      }),
    inject: [DB_CLIENT, API_CONFIG, RestrictionEffects, AppLogger],
  },
  {
    provide: ACCOUNT_KEYS,
    useFactory: (db: DbClient, keys: KeyProvider) => new AccountKeyStore({ db, keys }),
    inject: [DB_CLIENT, KEY_PROVIDER],
  },
  {
    provide: IDEMPOTENCY_STORE,
    useFactory: (db: DbClient, keys: KeyProvider) => new IdempotencyStore({ db, keys }),
    inject: [DB_CLIENT, KEY_PROVIDER],
  },
  {
    provide: ACCOUNT_DELETION,
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      access: D1AccessService,
      sessions: SessionService,
      logger: AppLogger,
      effects?: readonly AccountDeletionEffect[],
    ) =>
      new AccountDeletionService({
        db,
        keys,
        access,
        sessions: sessions.store,
        effects: effects ?? [],
        onEffectError: (effect, error) =>
          logger.warn("account.deletion_effect_failed", { effect, error }),
      }),
    inject: [
      DB_CLIENT,
      KEY_PROVIDER,
      ACCESS_SERVICE,
      SessionService,
      AppLogger,
      { token: ACCOUNT_DELETION_EFFECTS, optional: true },
    ],
  },
];
