import { generateText, isStepCount, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScriptedModel,
  ScriptExhaustedError,
  scriptedRejection,
  scriptedStreamError,
  scriptedText,
  scriptedToolCall,
} from "./ai-model.ts";

function renameTaskTool(executed: string[]) {
  return tool({
    description: "Rename the current task",
    inputSchema: z.object({ title: z.string().min(1) }),
    execute: async ({ title }) => {
      executed.push(title);
      return { ok: true, title };
    },
  });
}

describe("scripted AI model (§8.6)", () => {
  it("streams text in chunks with usage and a stop finish reason", async () => {
    const scripted = createScriptedModel([
      scriptedText("Three of the five projects have no image yet.", {
        usage: { inputTokens: 40, outputTokens: 11 },
      }),
    ]);
    const deltas: string[] = [];
    const result = streamText({
      model: scripted.model,
      prompt: "Which project images are missing?",
      telemetry: { isEnabled: false },
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") deltas.push(part.text);
    }
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("Three of the five projects have no image yet.");
    expect(await result.text).toBe("Three of the five projects have no image yet.");
    expect(await result.finishReason).toBe("stop");
    expect((await result.usage).inputTokens).toBe(40);
    expect((await result.usage).outputTokens).toBe(11);
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.remaining()).toBe(0);
  });

  it("runs a multi-step tool loop: tool call, execution, then a final answer", async () => {
    const executed: string[] = [];
    const scripted = createScriptedModel([
      scriptedToolCall(
        "renameTask",
        { title: "Refresh my portfolio" },
        { toolCallId: "call_rename" },
      ),
      scriptedText("Renamed the task."),
    ]);
    const result = streamText({
      model: scripted.model,
      prompt: "Rename this task",
      tools: { renameTask: renameTaskTool(executed) },
      stopWhen: isStepCount(5),
      telemetry: { isEnabled: false },
    });
    expect(await result.text).toBe("Renamed the task.");
    const steps = await result.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]?.finishReason).toBe("tool-calls");
    expect(steps[0]?.toolCalls.map((call) => [call.toolCallId, call.toolName, call.input])).toEqual(
      [["call_rename", "renameTask", { title: "Refresh my portfolio" }]],
    );
    expect(executed).toEqual(["Refresh my portfolio"]);

    // The second call carries the tool result back to the model.
    expect(scripted.calls).toHaveLength(2);
    const secondPrompt = JSON.stringify(scripted.calls[1]?.prompt);
    expect(secondPrompt).toContain("call_rename");
    expect(scripted.calls[0]?.tools?.map((entry) => entry.name)).toEqual(["renameTask"]);
  });

  it("supports generateText with text, reasoning and tool calls", async () => {
    const executed: string[] = [];
    const scripted = createScriptedModel([
      {
        parts: [
          { type: "reasoning", text: "The user wants a rename." },
          { type: "tool-call", toolName: "renameTask", input: { title: "Book a bike tune-up" } },
        ],
      },
      scriptedText("Done."),
    ]);
    const result = await generateText({
      model: scripted.model,
      prompt: "Rename",
      tools: { renameTask: renameTaskTool(executed) },
      stopWhen: isStepCount(3),
      telemetry: { isEnabled: false },
    });
    expect(result.text).toBe("Done.");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.toolCalls[0]?.toolCallId).toBe("call_1_1");
    expect(executed).toEqual(["Book a bike tune-up"]);
  });

  it("emits an in-stream error after partial text", async () => {
    const scripted = createScriptedModel([
      scriptedStreamError(new Error("provider overloaded"), "Partial"),
    ]);
    const errors: unknown[] = [];
    const types: string[] = [];
    const result = streamText({
      model: scripted.model,
      prompt: "Hello",
      telemetry: { isEnabled: false },
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    for await (const part of result.fullStream) types.push(part.type);
    expect(types).toContain("text-delta");
    expect(types).toContain("error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("provider overloaded");
  });

  it("rejects a call outright, and fails loudly when the script runs out", async () => {
    const rejecting = createScriptedModel([scriptedRejection(new Error("429 rate limited"))]);
    await expect(
      generateText({
        model: rejecting.model,
        prompt: "Hello",
        maxRetries: 0,
        telemetry: { isEnabled: false },
      }),
    ).rejects.toThrow("429 rate limited");

    const exhausted = createScriptedModel([scriptedText("only one")]);
    await generateText({ model: exhausted.model, prompt: "one", telemetry: { isEnabled: false } });
    await expect(
      generateText({
        model: exhausted.model,
        prompt: "two",
        maxRetries: 0,
        telemetry: { isEnabled: false },
      }),
    ).rejects.toBeInstanceOf(ScriptExhaustedError);
    expect(exhausted.calls).toHaveLength(2);
  });

  it("reports its provider and model id", () => {
    const scripted = createScriptedModel([], { provider: "openai", modelId: "fast" });
    expect(scripted.model.provider).toBe("openai");
    expect(scripted.model.modelId).toBe("fast");
    expect(scripted.model.specificationVersion).toBe("v4");
  });
});
