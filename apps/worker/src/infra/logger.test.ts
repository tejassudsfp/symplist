import { FakeTriggerClient } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { createWorkerLogger, redactLogFields } from "./logger.ts";

const MARKER = "MARKER-51aa-user-content";

describe("redacting worker logger (§8.3)", () => {
  it("passes allowlisted ids, codes, durations, counts and flags to Trigger's logger", () => {
    const trigger = new FakeTriggerClient();
    const logger = createWorkerLogger(trigger.logger);
    logger.info("run.step_completed", {
      runId: "01996d2a-4c00-7000-8000-000000000001",
      triggerRunId: "run_abc123",
      code: "tool.completed",
      status: "running",
      durationMs: 120,
      stepCount: 3,
      seq: 7,
      isRetry: false,
      inputBytes: 1_024,
    });
    expect(trigger.logs).toEqual([
      {
        level: "info",
        message: "run.step_completed",
        runId: null,
        properties: {
          runId: "01996d2a-4c00-7000-8000-000000000001",
          triggerRunId: "run_abc123",
          code: "tool.completed",
          status: "running",
          durationMs: 120,
          stepCount: 3,
          seq: 7,
          isRetry: false,
          inputBytes: 1_024,
        },
      },
    ]);
  });

  it("drops content in any field, unknown field names and free-text event names", () => {
    const trigger = new FakeTriggerClient();
    const logger = createWorkerLogger(trigger.logger);
    const hostile = {
      runId: `not-an-id ${MARKER}`,
      code: `Error: ${MARKER}`,
      durationMs: -5,
      count: 1.5,
      message: MARKER,
      prompt: MARKER,
      toolArgs: MARKER,
      [MARKER]: 1,
      stepCount: MARKER as unknown as number,
      isRetry: MARKER as unknown as boolean,
    };
    logger.warn("run.failed", hostile);
    logger.error(`Failed to send ${MARKER}`, { stepCount: 1 });
    expect(trigger.findMarker(MARKER)).toEqual([]);
    expect(trigger.logs[0]?.properties).toEqual({ redactedFields: 10 });
    expect(trigger.logs[1]).toMatchObject({
      message: "log.redacted_event",
      properties: { stepCount: 1 },
    });
  });

  it("redacts nested objects and arrays", () => {
    expect(
      redactLogFields({ runIds: [MARKER] as never, detailId: { a: MARKER } as never }),
    ).toEqual({ redactedFields: 2 });
  });
});
