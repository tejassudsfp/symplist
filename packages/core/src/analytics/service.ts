import { randomUUID } from "node:crypto";
import type {
  AnalyticsEventProperties,
  AnalyticsSubject,
  ServerAnalyticsEmitter,
  ServerAnalyticsEventName,
} from "@symplist/analytics/server";
import type {
  AnalyticsConsentRequest,
  AnalyticsSettings,
  AnalyticsTrackRequest,
} from "@symplist/contracts";
import type { DbClient, DbRow } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { AccessFeatureError, type AccessPolicy, accessCondition } from "../access/index.ts";

export class AnalyticsService {
  constructor(
    private readonly options: {
      readonly db: DbClient;
      readonly policy: AccessPolicy;
      readonly enabled: boolean;
      readonly emitter: ServerAnalyticsEmitter;
      readonly now: () => number;
    },
  ) {}

  private guard(): string {
    return accessCondition({ level: "admitted", policy: this.options.policy, userParam: "owner" });
  }

  private settings(row: DbRow): AnalyticsSettings {
    return {
      enabled: this.options.enabled,
      consent: {
        state: row.analytics_consent as AnalyticsSettings["consent"]["state"],
        decidedAt: row.analytics_consent_at as number | null,
      },
    };
  }

  async get(owner: string): Promise<AnalyticsSettings> {
    const row = await this.options.db.first(
      sql(
        `SELECT analytics_consent, analytics_consent_at FROM users WHERE id = :owner AND ${this.guard()}`,
        { owner },
      ),
    );
    if (!row) throw new AccessFeatureError("not_found");
    return this.settings(row);
  }

  /** A naturally idempotent owner preference. Never manufactures consent when disabled. */
  async set(owner: string, input: AnalyticsConsentRequest): Promise<AnalyticsSettings> {
    if (input.state === "granted" && !this.options.enabled)
      throw new AccessFeatureError("not_found");
    const write = uuidv7();
    const results = await this.options.db.batch([
      sql(
        `UPDATE users SET analytics_consent = :state,
        analytics_consent_at = CASE WHEN analytics_consent = :state THEN analytics_consent_at ELSE :now END,
        analytics_id = CASE WHEN :state = 'granted' THEN COALESCE(analytics_id, :identity) ELSE analytics_id END,
        write_id = :write WHERE id = :owner AND ${this.guard()}`,
        {
          state: input.state,
          now: int(this.options.now()),
          identity: randomUUID(),
          write,
          owner,
        },
      ),
      sql(
        `SELECT analytics_consent, analytics_consent_at FROM users WHERE id = :owner AND write_id = :write`,
        { owner, write },
      ),
    ]);
    const row = results[1]?.results[0];
    if (!row) throw new AccessFeatureError("not_found");
    return this.settings(row);
  }

  /** No persisted event queue or request contents. Failure is always non-blocking. */
  async track(owner: string, input: AnalyticsTrackRequest): Promise<void> {
    if (!this.options.enabled) return;
    try {
      const row = await this.options.db.first(
        sql(
          `SELECT analytics_consent, analytics_id FROM users WHERE id = :owner AND ${this.guard()}`,
          { owner },
        ),
      );
      if (row?.analytics_consent !== "granted" || typeof row.analytics_id !== "string") return;
      const subject: AnalyticsSubject = { consent: "granted", analyticsId: row.analytics_id };
      await this.options.emitter.captureClient?.({ ...input, subject });
    } catch {
      // Analytics must never make an application action fail, including during provider outages.
    }
  }

  async capture<Name extends ServerAnalyticsEventName>(
    owner: string,
    event: Name,
    properties: AnalyticsEventProperties<Name>,
    eventId: string,
  ): Promise<void> {
    if (!this.options.enabled) return;
    try {
      const row = await this.options.db.first(
        sql(
          `SELECT analytics_consent, analytics_id FROM users WHERE id = :owner AND ${this.guard()}`,
          { owner },
        ),
      );
      if (row?.analytics_consent !== "granted" || typeof row.analytics_id !== "string") return;
      await this.options.emitter.capture({
        subject: { consent: "granted", analyticsId: row.analytics_id },
        event,
        properties,
        eventId,
      });
    } catch {
      // A confirmed product action remains successful during an analytics outage.
    }
  }
}
