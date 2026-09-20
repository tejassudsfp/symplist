import { IntegrationError, normalizeIntegrationError } from "./errors.ts";

export interface ToolkitSummary {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly auth: "managed" | "api_key" | "none";
}

export interface ToolkitPageClient {
  toolkits: {
    list(input: {
      limit: number;
      cursor?: string;
      managed_by: "all";
      sort_by: "alphabetically";
    }): Promise<{
      items: readonly {
        slug: string;
        name: string;
        auth_schemes?: readonly string[];
        composio_managed_auth_schemes?: readonly string[];
        no_auth?: boolean;
        meta?: { description?: string };
      }[];
      next_cursor?: string | null;
    }>;
  };
}

/** Live catalogue, short memory cache only. Never receives a database or object store. */
export class ToolkitCatalogue {
  private cached: { until: number; value: readonly ToolkitSummary[] } | null = null;
  private pending: Promise<readonly ToolkitSummary[]> | null = null;
  constructor(
    private readonly client: ToolkitPageClient,
    private readonly now = Date.now,
  ) {}

  async list(): Promise<readonly ToolkitSummary[]> {
    if (this.cached && this.cached.until > this.now()) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try {
      const value = await this.pending;
      this.cached = { until: this.now() + 120_000, value };
      return value;
    } finally {
      this.pending = null;
    }
  }

  private async load(): Promise<readonly ToolkitSummary[]> {
    const items = new Map<string, ToolkitSummary>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 20; page++) {
        const result = await this.client.toolkits.list({
          limit: 1000,
          managed_by: "all",
          sort_by: "alphabetically",
          ...(cursor ? { cursor } : {}),
        });
        for (const item of result.items) {
          if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(item.slug)) continue;
          const auth = item.no_auth
            ? "none"
            : item.composio_managed_auth_schemes?.length
              ? "managed"
              : item.auth_schemes?.includes("API_KEY")
                ? "api_key"
                : null;
          if (!auth) continue;
          items.set(
            item.slug,
            Object.freeze({
              slug: item.slug,
              name: item.name.slice(0, 200),
              description: (item.meta?.description ?? "").slice(0, 500),
              auth,
            }),
          );
        }
        cursor = result.next_cursor || undefined;
        if (!cursor) return Object.freeze([...items.values()]);
        if (cursors.has(cursor)) throw new IntegrationError("integration.invalid_response");
        cursors.add(cursor);
      }
      throw new IntegrationError("integration.invalid_response");
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }
}
