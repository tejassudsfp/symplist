import { describe, expect, it } from "vitest";
import {
  acpBlockText,
  acpPermissionRequestSchema,
  acpStopReasonSchema,
  parseAcpUpdate,
} from "./acp.ts";

/*
 * The wire shapes are read defensively on purpose: the harness is a separate process on its own release
 * cadence, and the one failure mode worth designing against is a dsh upgrade that adds an update kind
 * and blanks the chat pane. Every fixture here is the shape `dsh-acp` actually emits — `tool_call` with
 * a hardcoded `kind: "other"` and the tool's programmatic name in `title`, and a permission request
 * carrying nothing but a `toolCallId`.
 */
describe("ACP update parsing", () => {
  it("reads the six updates the harness emits", () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "Done." },
      }),
    ).toMatchObject({ sessionUpdate: "agent_message_chunk", messageId: "m1" });
    expect(
      parseAcpUpdate({
        sessionUpdate: "agent_thought_chunk",
        messageId: "m1",
        content: { type: "text", text: "Checking the tests" },
      }),
    ).toMatchObject({ sessionUpdate: "agent_thought_chunk" });
    expect(
      parseAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "bash",
        kind: "other",
        status: "in_progress",
        rawInput: { command: "pnpm test" },
      }),
    ).toMatchObject({ sessionUpdate: "tool_call", title: "bash", kind: "other" });
    expect(
      parseAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "3 passed" } }],
      }),
    ).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
    expect(
      parseAcpUpdate({ sessionUpdate: "usage_update", used: 900, size: 128_000 }),
    ).toMatchObject({ used: 900, size: 128_000 });
    expect(
      parseAcpUpdate({
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: '["deepseek-official","deepseek-v4-pro"]',
            options: [
              { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek V4 Pro" },
            ],
          },
        ],
      }),
    ).toMatchObject({ configOptions: [{ id: "model", currentValue: expect.any(String) }] });
  });

  it("ignores an update kind it does not render rather than failing the whole notification", () => {
    // Every one of these is legal ACP that `dsh-acp` never sends. A future harness that does must not
    // be able to break the pane, so the answer is null — store the row, draw nothing.
    expect(parseAcpUpdate({ sessionUpdate: "plan", entries: [] })).toBeNull();
    expect(parseAcpUpdate({ sessionUpdate: "compaction_update", compactionId: "k1" })).toBeNull();
    expect(parseAcpUpdate({ sessionUpdate: "session_info_update", title: "Renamed" })).toBeNull();
    expect(
      parseAcpUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    ).toBeNull();
    expect(parseAcpUpdate({ sessionUpdate: "invented_by_a_later_release" })).toBeNull();
  });

  it("treats a malformed update as one to skip, not one to throw on", () => {
    expect(parseAcpUpdate(null)).toBeNull();
    expect(parseAcpUpdate("agent_message_chunk")).toBeNull();
    expect(parseAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "c1" })).toBeNull();
    expect(parseAcpUpdate({ sessionUpdate: "usage_update", used: "lots", size: 1 })).toBeNull();
  });

  it("keeps fields it does not model instead of stripping them", () => {
    const update = parseAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "bash",
      _meta: { dsh: { attempt: 2 } },
    });
    expect(update).toMatchObject({ _meta: { dsh: { attempt: 2 } } });
  });

  it("reads text out of a block and says nothing for a block that carries none", () => {
    expect(acpBlockText({ type: "text", text: "hello" })).toBe("hello");
    expect(acpBlockText({ type: "resource_link", uri: "file:///a.md" })).toBe("");
  });
});

describe("permission requests and stop reasons", () => {
  it("accepts the request the harness actually sends, which names only the tool call id", () => {
    const parsed = acpPermissionRequestSchema.safeParse({
      requestId: "r1",
      sessionId: "s1",
      toolCall: { toolCallId: "c1" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.options.map((option) => option.kind)).toEqual([
      "allow_once",
      "reject_once",
    ]);
  });

  it("keeps the four stop reasons ACP defines, so nothing invents a fifth", () => {
    expect(acpStopReasonSchema.options).toEqual([
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ]);
  });
});
