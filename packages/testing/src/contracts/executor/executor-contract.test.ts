import { describe, expect, it } from "vitest";
import { liveTriggerSettings } from "./executor-contract.ts";

describe("live Trigger executor contract gating (§17)", () => {
  it("skips with a visible reason unless LIVE_TRIGGER=1 and TRIGGER_SECRET_KEY are set", () => {
    expect(liveTriggerSettings({})).toEqual({
      skipReason: "set LIVE_TRIGGER=1 to run the live Trigger executor contract",
    });
    expect(
      liveTriggerSettings({ LIVE_TRIGGER: "0", TRIGGER_SECRET_KEY: "tr_dev_x" }),
    ).toMatchObject({
      skipReason: expect.stringContaining("LIVE_TRIGGER=1"),
    });
    expect(liveTriggerSettings({ LIVE_TRIGGER: "1" })).toEqual({
      skipReason: "LIVE_TRIGGER=1 but TRIGGER_SECRET_KEY missing",
    });
  });

  it("runs against the healthcheck task by default, or the named task", () => {
    expect(
      liveTriggerSettings({ LIVE_TRIGGER: "1", TRIGGER_SECRET_KEY: "tr_dev_abcdefgh" }),
    ).toEqual({
      settings: { secretKey: "tr_dev_abcdefgh", taskId: "symplist-healthcheck" },
    });
    expect(
      liveTriggerSettings({
        LIVE_TRIGGER: "1",
        TRIGGER_SECRET_KEY: "tr_dev_abcdefgh",
        LIVE_TRIGGER_TASK_ID: "probe-task",
      }),
    ).toMatchObject({ settings: { taskId: "probe-task" } });
  });
});
