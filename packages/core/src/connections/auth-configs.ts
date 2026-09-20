import { type DbClient, int, sql, uuidv7 } from "@symplist/db";
import {
  type ConnectionLifecycleProvider,
  IntegrationError,
  type ToolkitSummary,
} from "@symplist/integrations";

/** One durable lease per toolkit, shared by every API instance; never stores provider credentials. */
export class ComposioAuthConfigs {
  constructor(
    private readonly db: DbClient,
    private readonly provider: ConnectionLifecycleProvider,
    private readonly now = Date.now,
  ) {}

  async findOrCreate(toolkit: ToolkitSummary): Promise<string> {
    const write = uuidv7();
    const time = this.now();
    const result = await this.db.batch([
      sql(
        `INSERT INTO composio_auth_configs (toolkit, auth_kind, updated_at, write_id) VALUES (:toolkit, :kind, :now, :write) ON CONFLICT (toolkit) DO NOTHING`,
        { toolkit: toolkit.slug, kind: toolkit.auth, now: int(time), write },
      ),
      sql(
        `UPDATE composio_auth_configs SET lease_until = :until, write_id = :write WHERE toolkit = :toolkit AND auth_config_id IS NULL AND lease_until <= :now`,
        { until: int(time + 60_000), write, toolkit: toolkit.slug, now: int(time) },
      ),
      sql(
        `SELECT auth_config_id, write_id, lease_until FROM composio_auth_configs WHERE toolkit = :toolkit`,
        { toolkit: toolkit.slug },
      ),
    ]);
    const row = result[2]?.results[0];
    if (row?.auth_config_id) return String(row.auth_config_id);
    if (!row || row.write_id !== write || Number(row.lease_until) <= time)
      throw new IntegrationError("integration.unavailable");
    try {
      let cursor: string | undefined;
      const seen = new Set<string>();
      let config: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await this.provider.authConfigs(toolkit.slug, toolkit.auth, cursor);
        config = result.items.find(
          (item) =>
            item.toolkit === toolkit.slug &&
            item.enabled &&
            (toolkit.auth === "managed"
              ? item.managed
              : !item.managed &&
                item.scheme === (toolkit.auth === "api_key" ? "API_KEY" : "NO_AUTH")),
        )?.id;
        if (config || !result.cursor) break;
        if (seen.has(result.cursor) || page === 99)
          throw new IntegrationError("integration.invalid_response");
        seen.add(result.cursor);
        cursor = result.cursor;
      }
      // Recheck the lease immediately before creating an upstream object. A timed-out creation is
      // recovered by listing on the next attempt, never blindly retried by the SDK.
      const lease = await this.db.first(
        sql(
          `SELECT 1 FROM composio_auth_configs WHERE toolkit = :toolkit AND write_id = :write AND lease_until > :now`,
          { toolkit: toolkit.slug, write, now: int(this.now()) },
        ),
      );
      if (!lease) throw new IntegrationError("integration.unavailable");
      config ??= await this.provider.createAuthConfig(toolkit.slug, toolkit.auth);
      const stored = await this.db.batch([
        sql(
          `UPDATE composio_auth_configs SET auth_config_id = :config, auth_kind = :kind, lease_until = 0, updated_at = :now WHERE toolkit = :toolkit AND write_id = :write AND lease_until > :now`,
          { config, kind: toolkit.auth, now: int(this.now()), toolkit: toolkit.slug, write },
        ),
        sql(
          `SELECT auth_config_id FROM composio_auth_configs WHERE toolkit = :toolkit AND write_id = :write AND lease_until = 0 AND auth_config_id = :config`,
          { toolkit: toolkit.slug, write, config },
        ),
      ]);
      if (!stored[1]?.results[0]) throw new IntegrationError("integration.unavailable");
      return config;
    } finally {
      await this.db.run(
        sql(
          `UPDATE composio_auth_configs SET lease_until = 0 WHERE toolkit = :toolkit AND write_id = :write AND auth_config_id IS NULL`,
          { toolkit: toolkit.slug, write },
        ),
      );
    }
  }
}
