import type { Provider } from "@nestjs/common";
import {
  AccountAdminService,
  ActivityService,
  AdminBootstrapService,
  CampaignRevocationService,
  type D1AccessService,
  InviteAdminService,
  OtpService,
  ProfileService,
  RedemptionService,
} from "@symplist/core/access";
import { AccountDeletionRequestService, type AccountDeletionService } from "@symplist/core/account";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { EmailTransport } from "@symplist/email";
import { ACCESS_SERVICE, ACCOUNT_DELETION } from "../../common/access/access.providers.ts";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { EMAIL_TRANSPORT } from "../../infra/email/email.providers.ts";
import {
  ACCOUNT_ADMIN_SERVICE,
  ACCOUNT_DELETION_REQUESTS,
  ACTIVITY_SERVICE,
  ADMIN_BOOTSTRAP_SERVICE,
  CAMPAIGN_REVOCATION_SERVICE,
  INVITE_ADMIN_SERVICE,
  OTP_SERVICE,
  OTP_TEST_OUTBOX,
  PROFILE_SERVICE,
  REDEMPTION_SERVICE,
} from "./access.tokens.ts";
import { AccessRealtime } from "./access-realtime.ts";
import { ApiOtpMailer } from "./otp-mailer.ts";
import { OtpTestOutbox } from "./otp-test-outbox.ts";

const policyOf = (config: ApiConfig) => ({ betaAccessRequired: config.BETA_ACCESS_REQUIRED });
const nowOf = (clock: Clock) => () => clock.now();

/** The access feature's services, built from the platform's providers (§2.3). */
export const accessFeatureProviders: Provider[] = [
  AccessRealtime,
  {
    provide: OTP_TEST_OUTBOX,
    inject: [API_CONFIG],
    useFactory: (config: ApiConfig) => (config.NODE_ENV === "test" ? new OtpTestOutbox() : null),
  },
  {
    provide: OTP_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, EMAIL_TRANSPORT, API_CONFIG, CLOCK, OTP_TEST_OUTBOX],
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      email: EmailTransport,
      config: ApiConfig,
      clock: Clock,
      outbox: OtpTestOutbox | null,
    ) =>
      new OtpService({
        db,
        keys,
        mailer: new ApiOtpMailer(email, outbox),
        now: nowOf(clock),
        codeLength: config.OTP_LENGTH,
        ttlMinutes: config.OTP_TTL_MINUTES,
        maxAttempts: config.OTP_MAX_ATTEMPTS,
      }),
  },
  {
    provide: REDEMPTION_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, API_CONFIG, CLOCK],
    useFactory: (db: DbClient, keys: KeyProvider, config: ApiConfig, clock: Clock) =>
      new RedemptionService({ db, keys, policy: policyOf(config), now: nowOf(clock) }),
  },
  {
    provide: PROFILE_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, API_CONFIG, CLOCK, REDEMPTION_SERVICE],
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      config: ApiConfig,
      clock: Clock,
      redemptions: RedemptionService,
    ) => new ProfileService({ db, keys, policy: policyOf(config), now: nowOf(clock), redemptions }),
  },
  {
    provide: INVITE_ADMIN_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, API_CONFIG, CLOCK],
    useFactory: (db: DbClient, keys: KeyProvider, config: ApiConfig, clock: Clock) =>
      new InviteAdminService({ db, keys, policy: policyOf(config), now: nowOf(clock) }),
  },
  {
    provide: ACCOUNT_ADMIN_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, API_CONFIG, CLOCK, ACCESS_SERVICE],
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      config: ApiConfig,
      clock: Clock,
      access: D1AccessService,
    ) => new AccountAdminService({ db, keys, policy: policyOf(config), now: nowOf(clock), access }),
  },
  {
    provide: CAMPAIGN_REVOCATION_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, CLOCK, ACCESS_SERVICE, AccessRealtime],
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      clock: Clock,
      access: D1AccessService,
      realtime: AccessRealtime,
    ) =>
      new CampaignRevocationService({
        db,
        keys,
        now: nowOf(clock),
        access,
        onRestricted: async (userId) => {
          const state = await access.load(userId);
          if (state) await realtime.accessChanged(userId, state, { generationMoved: true });
        },
      }),
  },
  {
    provide: ACTIVITY_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER],
    useFactory: (db: DbClient, keys: KeyProvider) => new ActivityService({ db, keys }),
  },
  {
    provide: ADMIN_BOOTSTRAP_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, CLOCK],
    useFactory: (db: DbClient, keys: KeyProvider, clock: Clock) =>
      new AdminBootstrapService({ db, keys, now: nowOf(clock) }),
  },
  {
    provide: ACCOUNT_DELETION_REQUESTS,
    inject: [OTP_SERVICE, ACCOUNT_DELETION, CLOCK],
    useFactory: (otp: OtpService, deletion: AccountDeletionService, clock: Clock) =>
      new AccountDeletionRequestService({ otp, deletion, now: nowOf(clock) }),
  },
];
