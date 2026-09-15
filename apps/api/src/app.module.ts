import { type DynamicModule, Module, type ModuleMetadata } from "@nestjs/common";
import { PlatformModule, type PlatformOptions } from "./common/platform.module.ts";
import { PlatformSeamsModule } from "./common/seams.module.ts";
import type { TriggerClientBinding } from "./common/seams.ts";
import { type RuntimeOptions, runtimeModules } from "./infra/runtime/runtime.modules.ts";
import { AccessModule } from "./modules/access/access.module.ts";
import { AnalyticsModule } from "./modules/analytics/analytics.module.ts";
import { ConnectionsModule } from "./modules/connections/connections.module.ts";
import { DocumentsModule } from "./modules/documents/documents.module.ts";
import { SchedulingModule } from "./modules/scheduling/scheduling.module.ts";
import { SearchModule } from "./modules/search/search.module.ts";
import { SharingModule } from "./modules/sharing/sharing.module.ts";
import { SimonModule } from "./modules/simon/simon.module.ts";
import { SystemModule } from "./modules/system/system.module.ts";
import { VaultModule } from "./modules/vault/vault.module.ts";
import { WorkspaceModule } from "./modules/workspace/workspace.module.ts";

/** Every feature module, imported by the application in a fixed order (§2.3). */
export const featureModules = [
  SystemModule,
  AccessModule,
  WorkspaceModule,
  DocumentsModule,
  SearchModule,
  SimonModule,
  SchedulingModule,
  VaultModule,
  SharingModule,
  ConnectionsModule,
  AnalyticsModule,
] as const;

export interface AppModuleOptions extends PlatformOptions {
  /** Extra modules, for example test probe controllers. */
  readonly imports?: NonNullable<ModuleMetadata["imports"]>;
  /**
   * Replaces the Trigger client bound to `TRIGGER_CLIENT` (tests pass a `FakeTriggerClient`); by default
   * the SDK client when `DURABLE=true` and none otherwise.
   */
  readonly triggerClient?: TriggerClientBinding;
  /** Overrides for the executors, realtime, internal endpoints and scheduler (tests only). */
  readonly runtime?: RuntimeOptions;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes configured through a static forRoot.
export class AppModule {
  /**
   * The application module: the global platform, the seams bound from one global module, the runtime
   * modules (executors, realtime, internal endpoints, scheduler, account purge), then every feature.
   */
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { imports = [], triggerClient, runtime, ...platform } = options;
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(platform),
        PlatformSeamsModule.forRoot(triggerClient === undefined ? {} : { triggerClient }),
        ...runtimeModules(runtime),
        ...featureModules,
        ...imports,
      ],
    };
  }
}
