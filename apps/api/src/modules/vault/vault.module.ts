import { Module } from "@nestjs/common";
import type { OtpService } from "@symplist/core/access";
import {
  VaultGrants,
  VaultItems,
  VaultRepository,
  VaultReset,
  VaultSessions,
} from "@symplist/core/vault";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { OTP_SERVICE } from "../../infra/email/otp.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { VaultController } from "./vault.controller.ts";
import { VaultNotifications } from "./vault-notifications.ts";

/** The vault feature: controllers, gateway handlers and providers live in this folder (§2.3). */
@Module({
  controllers: [VaultController],
  providers: [
    VaultNotifications,
    {
      provide: VaultRepository,
      inject: [DB_CLIENT, KEY_PROVIDER, CLOCK, API_CONFIG, TopicHub],
      useFactory: (
        db: DbClient,
        keys: KeyProvider,
        clock: Clock,
        config: ApiConfig,
        hub: TopicHub,
      ) =>
        new VaultRepository({
          db,
          keys,
          now: () => clock.now(),
          policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          idleMinutes: config.VAULT_IDLE_LOCK_MINUTES,
          locked: (ownerId, reason) =>
            hub.publishToUser(ownerId, {
              type: "vault.locked",
              data: { reason: reason === "reset" ? "reset" : "revoked" },
            }),
        }),
    },
    {
      provide: VaultSessions,
      inject: [VaultRepository],
      useFactory: (repo: VaultRepository) => new VaultSessions(repo),
    },
    {
      provide: VaultItems,
      inject: [VaultSessions],
      useFactory: (sessions: VaultSessions) => new VaultItems(sessions),
    },
    {
      provide: VaultGrants,
      inject: [VaultSessions],
      useFactory: (sessions: VaultSessions) => new VaultGrants(sessions),
    },
    {
      provide: VaultReset,
      inject: [VaultRepository, OTP_SERVICE, VaultNotifications],
      useFactory: (repo: VaultRepository, otp: OtpService, notices: VaultNotifications) =>
        new VaultReset(repo, otp, (owner, id) => notices.flush(owner, id)),
    },
  ],
  exports: [VaultRepository, VaultSessions, VaultGrants],
})
export class VaultModule {}
