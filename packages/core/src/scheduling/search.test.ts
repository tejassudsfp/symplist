import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { schedulingSearchSourceContributor } from "../search/sources/contributors/scheduling.ts";
import { SchedulingService } from "./service.ts";

describe("authoritative deadline search metadata", () => {
  let env: DocumentsTestEnvironment;
  let owner: string;
  let service: SchedulingService;
  beforeEach(async () => {
    env = await createDocumentsTestEnvironment();
    owner = await env.createUser();
    service = new SchedulingService({
      db: env.db,
      keys: env.keys,
      policy: { betaAccessRequired: true },
      now: () => env.clock,
    });
  });
  afterEach(async () => env.close());
  it("distinguishes unscheduled, date-only and timed ranges without crossing owner boundaries", async () => {
    const date = await env.createTask(owner);
    const timed = await env.createTask(owner);
    const none = await env.createTask(owner);
    const otherOwner = await env.createUser();
    const foreign = await env.createTask(otherOwner);
    for (const [taskId, ownerId, deadline] of [
      [date, owner, { kind: "date", date: "2026-09-17", zone: "Asia/Kathmandu" }],
      [
        timed,
        owner,
        {
          kind: "timed",
          local: "2026-09-17T00:30",
          zone: "Asia/Kathmandu",
          disambiguation: "reject",
        },
      ],
      [foreign, otherOwner, { kind: "date", date: "2026-09-17", zone: "UTC" }],
    ] as const)
      await service.save({
        ownerId,
        taskId,
        actor: "user",
        requestId: `search-${taskId}`,
        data: { baseVersion: 0, deadline, reminders: [] },
      });
    const source = schedulingSearchSourceContributor.deadlines?.({
      db: env.db,
      keys: env.keys,
      objects: env.objects,
    });
    expect(source).toBeDefined();
    expect(await source?.matchingTaskIds(owner, { kind: "has" }, env.clock)).toEqual(
      new Set([date, timed]),
    );
    expect(await source?.matchingTaskIds(owner, { kind: "none" }, env.clock)).toEqual(
      new Set([none]),
    );
    expect(
      await source?.matchingTaskIds(
        owner,
        { kind: "range", from: "2026-09-17", to: "2026-09-17", timeZone: "UTC" },
        env.clock,
      ),
    ).toEqual(new Set([date]));
    expect(
      await source?.matchingTaskIds(
        owner,
        { kind: "range", from: "2026-09-16", to: "2026-09-16", timeZone: "UTC" },
        env.clock,
      ),
    ).toEqual(new Set([timed]));
    expect(
      await source?.matchingTaskIds(
        owner,
        { kind: "overdue", timeZone: "UTC" },
        Date.parse("2026-09-17T19:00Z"),
      ),
    ).toEqual(new Set([date, timed]));
  });
});
