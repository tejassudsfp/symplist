import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { cleanupMcp } from "@symplist/core/mcp";
import { RestrictionEffectRegistry } from "../../common/access/access.providers.ts";
import { LocalScheduler } from "../../infra/scheduler/local-scheduler.ts";
import { RUNTIME_TIMERS, type RuntimeTimers } from "../../infra/scheduler/runtime.ts";
import { MCP_TOOLS, type McpTools } from "./mcp-tools.ts";

@Injectable()
export class McpRegistration implements OnModuleInit, OnApplicationShutdown {
  private sweep: unknown;
  constructor(
    @Inject(MCP_TOOLS) private readonly tools: McpTools,
    @Inject(RestrictionEffectRegistry) private readonly restrictions: RestrictionEffectRegistry,
    @Inject(LocalScheduler) private readonly scheduler: LocalScheduler,
    @Inject(RUNTIME_TIMERS) private readonly timers: RuntimeTimers,
  ) {}
  onModuleInit(): void {
    this.restrictions.register({
      name: "mcp_search_cache_eviction",
      afterCommit: async (event) => {
        this.tools.search.queries.evictOwner(
          event.userId,
          event.reason === "deleted" ? "deleted" : "restricted",
        );
      },
    });
    this.sweep = this.timers.setInterval(() => this.tools.search.queries.sweep(), 60_000);
    this.scheduler.registerHourlyJob({
      name: "mcp-cleanup",
      minute: 5,
      run: async ({ generation }) => {
        await cleanupMcp({
          db: this.tools.grants.options.db,
          now: this.timers.now(),
          mode: "local",
          generation,
        });
      },
    });
  }
  onApplicationShutdown(): void {
    this.timers.clearInterval(this.sweep);
  }
}
