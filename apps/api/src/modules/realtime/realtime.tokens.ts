import type { DbClient } from "@symplist/db";
import type { z } from "zod";
import type { OperationalLog, RuntimeTimers } from "../../infra/scheduler/runtime.ts";
import type { AccessLevelPolicy } from "./topic-hub.ts";
import type { WsSessionResolver } from "./upgrade-gate.ts";

/** What the bootstrap supplies to the realtime module. */
export interface RealtimeDependencies {
  /** The api D1 client, for the 30-second session and access sweep. */
  readonly db: DbClient;
  /** Resolves the session cookie of an upgrade (`SessionUpgradeResolver` over the api sessions). */
  readonly sessions: WsSessionResolver;
  /** The guard-level check: the core `AccessService.satisfies` (§5.4). */
  readonly access: AccessLevelPolicy;
  /** `[WEB_ORIGIN]`. */
  readonly allowedOrigins: readonly string[];
  readonly timers?: RuntimeTimers;
  readonly log?: OperationalLog;
  /** Starts the 30-second heartbeat and access sweep when the gateway binds; defaults to true. */
  readonly backgroundLoops?: boolean;
  /** Event data schemas by type; defaults to the composed contracts `wsEvents`. */
  readonly events?: Readonly<Record<string, z.ZodType>>;
  /** Overrides for tests; production uses the §7 values. */
  readonly tuning?: {
    readonly heartbeatIntervalMs?: number;
    readonly sweepIntervalMs?: number;
    readonly shutdownGraceMs?: number;
    readonly frameWindowMs?: number;
    readonly framesPerWindow?: number;
    readonly bufferCapacity?: number;
    readonly idleTopicMs?: number;
    /** The session resolver's cache TTL, the margin for upgrades racing a post-commit hook. */
    readonly sessionCacheTtlMs?: number;
  };
}

export const REALTIME_DEPENDENCIES = "symplist:realtime-dependencies";
/** The `RealtimePublisher` from `@symplist/core/events`. */
export const REALTIME_PUBLISHER = "symplist:realtime-publisher";
