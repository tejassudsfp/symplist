import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  commonErrorCodes,
  decodeWsServerFrame,
  defineTools,
  errorCodes,
  errorHttpStatus,
  featureIds,
  isErrorCode,
  misownedUserTopicEvents,
  userTopicEventOwners,
  wsEventsByFeature,
  wsServerFrameSchema,
} from "../index.ts";

describe("composed contracts index", () => {
  it("includes every foundation error code with its status", () => {
    for (const [code, status] of Object.entries(commonErrorCodes)) {
      expect(isErrorCode(code)).toBe(true);
      if (isErrorCode(code)) expect(errorHttpStatus(code)).toBe(status);
    }
    expect(errorHttpStatus("rate.limited")).toBe(503);
    expect(errorHttpStatus("idempotency.mismatch")).toBe(422);
    expect(isErrorCode("made.up")).toBe(false);
    expect(isErrorCode("constructor")).toBe(false);
    expect(Object.isFrozen(errorCodes)).toBe(true);
  });

  it("assigns every user-topic event to a canonical feature and to nobody else", () => {
    for (const owner of Object.values(userTopicEventOwners)) {
      expect(featureIds).toContain(owner);
    }
    expect(misownedUserTopicEvents(wsEventsByFeature)).toEqual([]);
  });

  it("decodes the frames every composition accepts and ignores everything else", () => {
    expect(decodeWsServerFrame('{"t":"pong"}')).toEqual({ t: "pong" });
    expect(decodeWsServerFrame('{"t":"err","code":"not_found"}')).toEqual({
      t: "err",
      code: "not_found",
    });
    expect(decodeWsServerFrame('{"t":"resync","topic":"user"}')).toEqual({
      t: "resync",
      topic: "user",
    });
    expect(wsServerFrameSchema.safeParse({ t: "pong", extra: true }).success).toBe(false);
    for (const text of [
      "",
      "{",
      "[]",
      '{"t":"ev","topic":"user","seq":1,"id":"x","type":"nope","data":{}}',
    ]) {
      expect(decodeWsServerFrame(text)).toBeNull();
    }
  });

  it("rejects malformed tool names", () => {
    const contract = { input: z.strictObject({}), output: z.strictObject({}) };
    expect(defineTools({ task_context: contract })).toHaveProperty("task_context");
    expect(() => defineTools({ "task-context": contract })).toThrow(/Invalid tool name/);
    expect(() => defineTools({ TaskContext: contract })).toThrow(/Invalid tool name/);
  });
});
