import { sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { AnalyticsService } from "./service.ts";

describe("analytics consent and private identity", () => {
  let env: DocumentsTestEnvironment;
  let owner: string;
  const captureClient = vi.fn(async () => ({ status: "queued" as const }));
  function service(enabled = true) {
    return new AnalyticsService({
      db: env.db,
      enabled,
      policy: { betaAccessRequired: true },
      now: () => env.clock,
      emitter: { enabled, capture: vi.fn(), captureClient, flush: vi.fn(), shutdown: vi.fn() },
    });
  }
  beforeEach(async () => {
    env = await createDocumentsTestEnvironment();
    owner = await env.createUser();
    captureClient.mockClear();
  });
  afterEach(async () => {
    await env.close();
  });
  it("starts unset and exposes no identity in any response", async () => {
    expect(await service().get(owner)).toEqual({
      enabled: true,
      consent: { state: "unset", decidedAt: null },
    });
    const response = await service().set(owner, { state: "granted" });
    const row = await env.db.first(
      sql("SELECT analytics_id FROM users WHERE id = :owner", { owner }),
    );
    expect(row?.analytics_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.analytics_id).not.toBe(owner);
    expect(JSON.stringify(response)).not.toContain(row?.analytics_id);
    expect(Object.keys(response)).toEqual(["enabled", "consent"]);
  });
  it("assigns different random identities, preserves one across consent choices, and retries are stable", async () => {
    const first = await service().set(owner, { state: "granted" });
    const other = await env.createUser();
    await service().set(other, { state: "granted" });
    env.clock += 5000;
    expect(await service().set(owner, { state: "granted" })).toEqual(first);
    const before = await env.db.first(
      sql("SELECT analytics_id FROM users WHERE id = :owner", { owner }),
    );
    await service().set(owner, { state: "denied" });
    await service().set(owner, { state: "granted" });
    const rows = await env.db.all(sql("SELECT analytics_id FROM users"));
    expect(new Set(rows.map((row) => row.analytics_id)).size).toBe(2);
    expect(rows.map((row) => row.analytics_id)).toContain(before?.analytics_id);
  });
  it("denial needs no identity and disabled deployments cannot grant", async () => {
    await service().set(owner, { state: "denied" });
    expect(
      (await env.db.first(sql("SELECT analytics_id FROM users WHERE id = :owner", { owner })))
        ?.analytics_id,
    ).toBeNull();
    await expect(service(false).set(owner, { state: "granted" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("re-reads consent and access before every first-party event", async () => {
    const event = {
      event: "quick_chat_started" as const,
      eventId: "f8649900-bc01-4000-8000-000000000001",
      properties: { entry: "button" as const },
    };
    await service().track(owner, event);
    expect(captureClient).not.toHaveBeenCalled();
    await service().set(owner, { state: "granted" });
    await service().track(owner, event);
    expect(captureClient).toHaveBeenCalledOnce();
    await service().set(owner, { state: "denied" });
    await service().track(owner, event);
    await service().set(owner, { state: "granted" });
    await env.relock(owner);
    await service().track(owner, event);
    expect(captureClient).toHaveBeenCalledOnce();
    await expect(service().set(owner, { state: "denied" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
