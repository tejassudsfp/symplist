import * as analytics from "@symplist/analytics/server";
import { applyMigrations, createLocalSqliteClient, sql, uuidv7 } from "@symplist/db";
import { expect, it, vi } from "vitest";
import { workerAnalytics } from "./analytics.ts";
import { createWorkerLogger } from "./logger.ts";

it("uses one immediate emitter per runtime and rechecks consent/access for each confirmed event", async () => {
  const db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  const capture = vi.fn(async () => ({ status: "sent" as const }));
  const create = vi
    .spyOn(analytics, "createServerAnalytics")
    .mockReturnValue({ enabled: true, capture, flush: async () => {}, shutdown: async () => {} });
  try {
    await applyMigrations(db);
    const owner = uuidv7();
    const identity = uuidv7();
    await db.run(
      sql(
        `INSERT INTO users (id,email,email_verified_at,onboarding_step,beta_state,analytics_consent,analytics_id,created_at,updated_at,write_id)
      VALUES (:id,'analytics@example.test',0,'done','unlocked','unset',:identity,0,0,:write)`,
        { id: owner, identity, write: uuidv7() },
      ),
    );
    const runtime = {
      db,
      config: {
        ANALYTICS_ENABLED: true,
        POSTHOG_PROJECT_KEY: "fake-test-project",
        POSTHOG_HOST: "https://us.i.posthog.com",
        BETA_ACCESS_REQUIRED: true,
      },
      logger: createWorkerLogger(),
    };
    const service = workerAnalytics(runtime);
    expect(workerAnalytics(runtime)).toBe(service);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ delivery: "immediate" }));
    const event = uuidv7();
    const properties = {
      target: "coding_assistant" as const,
      sections: "whole_document" as const,
      author: "simon" as const,
    };
    await service.capture(owner, "handoff_prepared", properties, event);
    expect(capture).not.toHaveBeenCalled();
    await db.run(
      sql("UPDATE users SET analytics_consent='granted',analytics_consent_at=1 WHERE id=:id", {
        id: owner,
      }),
    );
    await service.capture(owner, "handoff_prepared", properties, event);
    expect(capture).toHaveBeenCalledExactlyOnceWith({
      subject: { consent: "granted", analyticsId: identity },
      event: "handoff_prepared",
      properties,
      eventId: event,
    });
    capture.mockClear();
    await db.run(sql("UPDATE users SET beta_state='relocked' WHERE id=:id", { id: owner }));
    await service.capture(owner, "handoff_prepared", properties, uuidv7());
    expect(capture).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    db.close();
  }
});
