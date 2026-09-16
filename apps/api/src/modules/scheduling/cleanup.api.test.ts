import { sql } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import {
  type HourlyJobRegistration,
  LocalScheduler,
} from "../../infra/scheduler/local-scheduler.ts";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

describe("local cleanup adapter", () => {
  it("registers the shared cleanup at :05 and uses the injected clock and object store", async () => {
    const registrations: HourlyJobRegistration[] = [];
    const original = LocalScheduler.prototype.registerHourlyJob;
    vi.spyOn(LocalScheduler.prototype, "registerHourlyJob").mockImplementation(function (
      this: LocalScheduler,
      job,
    ) {
      registrations.push(job);
      return original.call(this, job);
    });
    app = await bootTestApp();
    const user = await app.createSignedInUser("admitted");
    const job = registrations.find((item) => item.name === "cleanup-hourly");
    expect(job?.minute).toBe(5);
    const state = await app.db.first(sql("SELECT generation FROM executor_state WHERE id=1"));
    const list = vi.spyOn(app.objects, "list").mockResolvedValue({ objects: [] });
    await job?.run({
      name: "cleanup-hourly",
      generation: Number(state?.generation),
      scheduledFor: app.clock.now(),
      signal: new AbortController().signal,
    });
    expect(list).toHaveBeenCalledWith({ prefix: `u/${user.id}/artifacts/`, limit: 100 });
    expect(
      await app.db.first(
        sql("SELECT owner_id,lease_until FROM cleanup_cursors WHERE id='artifacts'"),
      ),
    ).toEqual({ owner_id: user.id, lease_until: 0 });
    await app.db.run(
      sql("UPDATE executor_state SET mode='durable',generation=generation+1 WHERE id=1"),
    );
    list.mockClear();
    await job?.run({
      name: "cleanup-hourly",
      generation: Number(state?.generation),
      scheduledFor: app.clock.now(),
      signal: new AbortController().signal,
    });
    expect(list).not.toHaveBeenCalled();
  });
});
