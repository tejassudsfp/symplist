import { describe, expect, it } from "vitest";
import {
  approvalIdSchema,
  brandedIdSchema,
  conversationIdSchema,
  idSchema,
  type RunId,
  runIdSchema,
  type TaskId,
  taskIdSchema,
  userIdSchema,
  uuidV7Pattern,
} from "./ids.ts";

const valid = "0199a5a0-7c1e-7b3a-9f2e-3c4d5e6f7a8b";

describe("UUIDv7 ids (§3.4)", () => {
  it("accepts canonical lowercase UUIDv7 strings and round-trips them through JSON", () => {
    for (const id of [
      valid,
      "0199a5a0-7c1f-7000-8000-000000000001",
      "ffffffff-ffff-7fff-bfff-ffffffffffff",
    ]) {
      expect(idSchema.parse(JSON.parse(JSON.stringify(id)))).toBe(id);
      expect(uuidV7Pattern.test(id)).toBe(true);
    }
  });

  it.each([
    ["uppercase", valid.toUpperCase()],
    ["UUIDv4", "9b2e7c1e-1a3b-4f2e-9c4d-5e6f7a8b9c0d"],
    ["nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["wrong variant", "0199a5a0-7c1e-7b3a-cf2e-3c4d5e6f7a8b"],
    ["braces", `{${valid}}`],
    ["surrounding whitespace", ` ${valid} `],
    ["trailing newline", `${valid}\n`],
    ["no hyphens", valid.replaceAll("-", "")],
    ["truncated", valid.slice(0, -1)],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(idSchema.safeParse(value).success).toBe(false);
  });

  it("rejects non-string values", () => {
    for (const value of [null, undefined, 42, {}, [valid]]) {
      expect(idSchema.safeParse(value).success).toBe(false);
    }
  });

  it("brands ids per entity so they cannot be swapped", () => {
    const taskId: TaskId = taskIdSchema.parse(valid);
    const runId: RunId = runIdSchema.parse(valid);
    const acceptTask = (id: TaskId) => id;
    expect(acceptTask(taskId)).toBe(valid);
    // @ts-expect-error a RunId is not a TaskId
    acceptTask(runId);
    // @ts-expect-error a plain string is not a TaskId until it is parsed
    acceptTask(valid);
    expect(conversationIdSchema.safeParse("not-an-id").success).toBe(false);
    expect(approvalIdSchema.parse(valid)).toBe(valid);
    expect(userIdSchema.description).toBe("UserId (UUIDv7)");
  });

  it("declares feature-specific branded ids with the same validation", () => {
    const widgetIdSchema = brandedIdSchema("WidgetId");
    expect(widgetIdSchema.parse(valid)).toBe(valid);
    expect(widgetIdSchema.safeParse(valid.toUpperCase()).success).toBe(false);
  });
});
