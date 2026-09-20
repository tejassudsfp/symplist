import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency } from "@nestjs/common";

/**
 * The `forRoot` options of the realtime, internal, executors and scheduler modules: the bootstrap
 * (config, D1, key and session providers) supplies each module's dependencies through a factory, so
 * these modules never depend on how those providers are built.
 */
export interface ModuleDependenciesOptions<Dependencies> {
  readonly imports?: ModuleMetadata["imports"];
  readonly inject?: readonly (InjectionToken | OptionalFactoryDependency)[];
  // biome-ignore lint/suspicious/noExplicitAny: Nest factories receive the injected values positionally.
  readonly useFactory: (...args: any[]) => Dependencies | Promise<Dependencies>;
}
