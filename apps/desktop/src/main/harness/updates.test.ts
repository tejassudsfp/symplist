import type { SessionConfigOption, SessionUpdate, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  contentBlockText,
  mergeToolCall,
  optionChoices,
  projectUpdate,
  type ToolCallState,
  toAssistantOptions,
  toolContentText,
} from "./updates.ts";

const now = () => 1_000;
const context = () => ({ tools: new Map<string, ToolCallState>(), now });

describe("contentBlockText", () => {
  it("reads text", () => {
    expect(contentBlockText({ type: "text", text: "hello" })).toBe("hello");
  });

  it("renders a resource link rather than fetching it", () => {
    expect(
      contentBlockText({ type: "resource_link", name: "notes.md", uri: "file:///notes.md" }),
    ).toBe("[notes.md](file:///notes.md)");
  });

  it("names a binary block instead of carrying its bytes into the renderer", () => {
    expect(contentBlockText({ type: "image", data: "AAAA", mimeType: "image/png" })).toBe(
      "[image]",
    );
  });
});

describe("toolContentText", () => {
  it("summarises a diff by its path", () => {
    // A tool that rewrites a document section returns the whole new text; inlining it into the
    // timeline would put a document in a chat bubble.
    expect(toolContentText([{ type: "diff", path: "/w/doc.md", newText: "a\nb\nc" }])).toBe(
      "--- /w/doc.md",
    );
  });

  it("joins several content blocks and drops the empty ones", () => {
    expect(
      toolContentText([
        { type: "content", content: { type: "text", text: "one" } },
        { type: "content", content: { type: "text", text: "" } },
        { type: "content", content: { type: "text", text: "two" } },
      ]),
    ).toBe("one\ntwo");
  });
});

describe("mergeToolCall", () => {
  const base = (): ToolCallState => ({
    id: "t1",
    title: "Running ls",
    name: "bash",
    status: "pending",
    output: "before",
  });

  it("keeps a field an update left absent", () => {
    const merged = mergeToolCall(base(), { toolCallId: "t1", status: "in_progress" });
    expect(merged.title).toBe("Running ls");
    expect(merged.name).toBe("bash");
    expect(merged.status).toBe("in_progress");
  });

  it("keeps a field an update spelled null, because null means unchanged in ACP", () => {
    const update: ToolCallUpdate = { toolCallId: "t1", title: null, status: null, content: null };
    const merged = mergeToolCall(base(), update);
    expect(merged.title).toBe("Running ls");
    expect(merged.status).toBe("pending");
    expect(merged.output).toBe("before");
  });

  it("replaces output rather than appending, because content replaces its collection", () => {
    const merged = mergeToolCall(base(), {
      toolCallId: "t1",
      content: [{ type: "content", content: { type: "text", text: "after" } }],
    });
    expect(merged.output).toBe("after");
  });
});

describe("optionChoices", () => {
  it("carries the group name onto every choice", () => {
    // The model option arrives grouped by provider route; a picker of thirty bare model names with no
    // provider beside them is unusable.
    const option: SessionConfigOption = {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: '["openai","gpt-5"]',
      options: [
        {
          group: "openai",
          name: "openai",
          options: [{ value: '["openai","gpt-5"]', name: "GPT-5" }],
        },
      ],
    };
    expect(optionChoices(option)).toEqual([
      { value: '["openai","gpt-5"]', name: "GPT-5", description: null, group: "openai" },
    ]);
  });

  it("handles a flat option list too", () => {
    const option: SessionConfigOption = {
      id: "reasoning_effort",
      name: "Reasoning effort",
      type: "select",
      currentValue: "",
      options: [{ value: "high", name: "High" }],
    };
    expect(optionChoices(option)).toEqual([
      { value: "high", name: "High", description: null, group: null },
    ]);
  });
});

describe("toAssistantOptions", () => {
  it("stringifies a boolean option's value, keeping it opaque to the renderer", () => {
    expect(
      toAssistantOptions([
        { id: "autorun", name: "Autorun", type: "boolean", currentValue: true },
      ])[0],
    ).toMatchObject({ currentValue: "true", choices: [] });
  });

  it("answers an absent option set with an empty list", () => {
    expect(toAssistantOptions(null)).toEqual([]);
  });
});

describe("projectUpdate", () => {
  it("turns a committed agent message into one timeline entry", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
      messageId: "m1",
    };
    expect(projectUpdate(update, context())).toEqual({
      kind: "entry",
      entry: { kind: "message", id: "m1", at: 1_000, text: "done" },
    });
  });

  it("keeps a thought distinct from a message", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    };
    const effect = projectUpdate(update, context());
    expect(effect.kind === "entry" && effect.entry.kind).toBe("thought");
  });

  it("registers a tool call and then updates the same entry id", () => {
    const shared = context();
    const created = projectUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Update section",
        name: "task_document_update_section",
        status: "pending",
      },
      shared,
    );
    const updated = projectUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      },
      shared,
    );
    expect(created.kind === "entry" && created.entry.id).toBe("t1");
    expect(updated).toEqual({
      kind: "entry",
      entry: {
        kind: "tool",
        id: "t1",
        at: 1_000,
        title: "Update section",
        name: "task_document_update_section",
        status: "completed",
        output: "ok",
      },
    });
  });

  it("accepts an update for a tool call it never saw start", () => {
    // Possible after a resume, or if a notification is lost. Inventing the entry keeps the timeline
    // complete rather than silently short.
    const effect = projectUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "t9", status: "failed" },
      context(),
    );
    expect(effect.kind === "entry" && effect.entry).toMatchObject({ id: "t9", status: "failed" });
  });

  it("reports a whole option set on a config change", () => {
    const effect = projectUpdate(
      {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "x",
            options: [{ value: "x", name: "X" }],
          },
        ],
      },
      context(),
    );
    expect(effect.kind).toBe("options");
  });

  it("ignores the updates that describe the context window rather than the conversation", () => {
    expect(
      projectUpdate({ sessionUpdate: "usage_update", used: 1_200, size: 200_000 }, context()).kind,
    ).toBe("ignored");
  });
});
