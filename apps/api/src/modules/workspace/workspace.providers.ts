import type { Provider } from "@nestjs/common";
import {
  MemoryPreferencesCache,
  type PreferencesCache,
  PreferencesService,
} from "@symplist/core/preferences";
import { MemoryTaskTreeCache, TaskService, type TaskTreeCache } from "@symplist/core/tasks";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";

/** The api's owner task tree cache (§3.3): 60-second TTL, invalidated on write and by events. */
export const TASK_TREE_CACHE = "symplist:workspace:TASK_TREE_CACHE";
/** `core/tasks` over the api's D1 client, tree cache and archive contributors. */
export const TASK_SERVICE = "symplist:workspace:TASK_SERVICE";
/** The api's preferences cache (§3.3). */
export const PREFERENCES_CACHE = "symplist:workspace:PREFERENCES_CACHE";
/** `core/preferences` over the api's D1 client and preferences cache. */
export const PREFERENCES_SERVICE = "symplist:workspace:PREFERENCES_SERVICE";

export const workspaceProviders: Provider[] = [
  {
    provide: TASK_TREE_CACHE,
    inject: [CLOCK],
    useFactory: (clock: Clock): TaskTreeCache =>
      new MemoryTaskTreeCache({ now: () => clock.now() }),
  },
  {
    provide: TASK_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, API_CONFIG, CLOCK, TASK_TREE_CACHE],
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      config: ApiConfig,
      clock: Clock,
      cache: TaskTreeCache,
    ) =>
      new TaskService({
        db,
        keys,
        policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
        now: () => clock.now(),
        cache,
      }),
  },
  {
    provide: PREFERENCES_CACHE,
    inject: [CLOCK],
    useFactory: (clock: Clock): PreferencesCache =>
      new MemoryPreferencesCache({ now: () => clock.now() }),
  },
  {
    provide: PREFERENCES_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, API_CONFIG, CLOCK, PREFERENCES_CACHE],
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      config: ApiConfig,
      clock: Clock,
      cache: PreferencesCache,
    ) =>
      new PreferencesService({
        db,
        keys,
        policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
        now: () => clock.now(),
        cache,
      }),
  },
];
