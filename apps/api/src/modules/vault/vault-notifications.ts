import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type DbClient, int, sql } from "@symplist/db";
import { createEmailRenderer, type EmailTransport, toEmailMessage } from "@symplist/email";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { EMAIL_TRANSPORT } from "../../infra/email/email.providers.ts";

/** Audit-backed security notice reconciliation. The provider key deduplicates deploy overlap. */
@Injectable()
export class VaultNotifications implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(EMAIL_TRANSPORT) private readonly email: EmailTransport,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.flush().catch(() => this.logger.warn("vault.notice_retry_failed"));
    }, 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async flush(ownerId?: string, auditId?: string) {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.db.all(
        sql(
          `SELECT a.id,a.owner_id,a.created_at,u.email FROM vault_audit a JOIN users u ON u.id=a.owner_id WHERE a.notification_sent_at IS NULL AND u.deletion_state='none' ${ownerId ? "AND a.owner_id=:owner" : ""} ${auditId ? "AND a.id=:id" : ""} ORDER BY a.created_at LIMIT 10`,
          { ...(ownerId ? { owner: ownerId } : {}), ...(auditId ? { id: auditId } : {}) },
        ),
      );
      const renderer = createEmailRenderer({
        webOrigin: this.config.WEB_ORIGIN,
        apiOrigin: this.config.API_ORIGIN,
        accountHelpUrl: new URL("/settings/account", this.config.WEB_ORIGIN).href,
      });
      for (const row of rows) {
        const rendered = await renderer.vaultResetNotice({
          changedAt: Number(row.created_at),
          timeZone: "UTC",
        });
        await this.email.send(
          toEmailMessage(rendered, {
            to: String(row.email),
            idempotencyKey: `vault-reset/${String(row.id)}`,
          }),
        );
      }
      if (rows.length)
        await this.db.batch(
          rows.map((row) =>
            sql(
              `UPDATE vault_audit SET notification_sent_at=:now WHERE id=:id AND owner_id=:owner AND notification_sent_at IS NULL`,
              { now: int(this.clock.now()), id: String(row.id), owner: String(row.owner_id) },
            ),
          ),
        );
    } finally {
      this.running = false;
    }
  }
}
