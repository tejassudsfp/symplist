import { Module } from "@nestjs/common";
import { accessFeatureProviders } from "./access.providers.ts";
import { AccessBackgroundJobs } from "./access-background.ts";
import { AccountDeletionController } from "./account-deletion.controller.ts";
import { AdminAccountsController } from "./admin-accounts.controller.ts";
import { AdminActivityController } from "./admin-activity.controller.ts";
import { AdminCampaignsController } from "./admin-campaigns.controller.ts";
import { AdminInvitesController } from "./admin-invites.controller.ts";
import { AuthController } from "./auth.controller.ts";
import { MeController } from "./me.controller.ts";
import { RedeemAccountLimitGuard, RedeemController } from "./redeem.controller.ts";
import { TestOtpController } from "./test-otp.controller.ts";

/**
 * The access feature (§5): sign-in and signup with email OTP, the signed-in identity and onboarding,
 * beta invite redemption, account deletion requests, beta administration (invites, accounts, campaign
 * revocation, activity), admin bootstrap and the redemption reconciler.
 */
@Module({
  controllers: [
    AuthController,
    TestOtpController,
    MeController,
    RedeemController,
    AccountDeletionController,
    AdminInvitesController,
    AdminAccountsController,
    AdminCampaignsController,
    AdminActivityController,
  ],
  providers: [...accessFeatureProviders, RedeemAccountLimitGuard, AccessBackgroundJobs],
})
export class AccessModule {}
