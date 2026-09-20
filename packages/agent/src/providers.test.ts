import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, jsonSchema, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoProviderExecutedTools,
  createSimonModels,
  type SimonModelConfig,
} from "./providers.ts";

const base: SimonModelConfig = {
  NODE_ENV: "test",
  AI_ENABLED: true,
  AI_PROVIDER_MODE: "live",
  AI_FAST_PROVIDER: "openai",
  AI_FAST_MODEL: "gpt-5.6-luna",
  AI_SMART_PROVIDER: "openai",
  AI_SMART_MODEL: "gpt-5.6-terra",
};
afterEach(() => vi.unstubAllEnvs());

describe("Simon provider registry", () => {
  it.each(["fast", "smart"] as const)(
    "sends %s to Responses with immutable privacy settings",
    async (tier) => {
      const requests: {
        url: string;
        body: Record<string, unknown>;
        authorization: string | null;
      }[] = [];
      vi.stubEnv("OPENAI_BASE_URL", "https://wrong.example.test");
      const models = createSimonModels(
        { ...base, OPENAI_API_KEY: "test-not-a-real-key" },
        {
          fetch: async (url, init) => {
            requests.push({
              url: String(url),
              body: JSON.parse(String(init?.body)),
              authorization: new Headers(init?.headers).get("authorization"),
            });
            return Response.json({
              id: "resp_test",
              object: "response",
              created_at: 1,
              model: "test",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: "msg_test",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Hello", annotations: [] }],
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            });
          },
        },
      );
      const selected = models.resolve(tier);
      expect(models.resolve(tier)).toBe(selected);
      expect(typeof selected.model).toBe("object");
      const result = await generateText({
        model: selected.model,
        instructions: "Workspace helper",
        prompt: "Hi",
        maxRetries: 0,
        providerOptions: {
          openai: { store: true, reasoningSummary: "detailed", parallelToolCalls: true },
        },
        telemetry: { isEnabled: false },
      });
      expect(result.text).toBe("Hello");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "https://api.openai.com/v1/responses",
        authorization: "Bearer test-not-a-real-key",
        body: {
          model: tier === "fast" ? "gpt-5.6-luna" : "gpt-5.6-terra",
          store: false,
          parallel_tool_calls: false,
          prompt_cache_options: { mode: "implicit", ttl: "30m" },
          reasoning: { effort: tier === "fast" ? "low" : "medium" },
        },
      });
      expect(JSON.stringify(requests[0]?.body)).not.toContain("detailed");
    },
  );

  it.each(["openai", "bedrock", "vertex", "together"] as const)(
    "refuses missing %s configuration without fetch",
    (provider) => {
      vi.stubEnv("OPENAI_API_KEY", "ambient-not-authority");
      const fetcher = vi.fn();
      expect(() =>
        createSimonModels({ ...base, AI_FAST_PROVIDER: provider }, { fetch: fetcher }).resolve(
          "fast",
        ),
      ).toThrow("ai.unavailable");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("does not let configured fast credentials authorize another smart provider", () => {
    const models = createSimonModels({
      ...base,
      OPENAI_API_KEY: "test-key",
      AI_SMART_PROVIDER: "together",
    });
    expect(models.resolve("fast").modelId).toBe("gpt-5.6-luna");
    expect(() => models.resolve("smart")).toThrow("ai.unavailable");
  });
  it("disabled AI never falls back to the scripted model", () => {
    expect(() =>
      createSimonModels({ ...base, AI_ENABLED: false, AI_PROVIDER_MODE: "scripted" }).resolve(
        "fast",
      ),
    ).toThrow("ai.unavailable");
  });
  it.each(["test", "development"] as const)("runs an explicit script in %s", async (NODE_ENV) => {
    const model = createSimonModels({ ...base, NODE_ENV, AI_PROVIDER_MODE: "scripted" }).resolve(
      "fast",
    ).model;
    expect(
      await streamText({ model, prompt: "Hi", telemetry: { isEnabled: false } }).text,
    ).toContain("Scripted development");
  });
  it("runs the browser document contract through two separate scripted tool steps", async () => {
    const model = createSimonModels({ ...base, AI_PROVIDER_MODE: "scripted" }).resolve(
      "fast",
    ).model;
    const taskId = "01234567-89ab-7def-8123-456789abcdef";
    const sectionId = "s0123456789abcdefghijklmno";
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const markdown = "## Projects\n\nUpdated through Simon.\n";
    const directive = Buffer.from(
      JSON.stringify({ taskId, sectionId, revision, markdown }),
      "utf8",
    ).toString("base64url");
    const calls: Array<{ name: string; input: unknown }> = [];
    const inputSchema = jsonSchema<Record<string, unknown>>({ type: "object" });
    const result = streamText({
      model,
      prompt: `Please update this section. symplist-e2e-document-edit:${directive}`,
      tools: {
        task_document_read_section: tool({
          inputSchema,
          execute: async (input) => {
            calls.push({ name: "read", input });
            return { text: "Original section" };
          },
        }),
        task_document_update_section: tool({
          inputSchema,
          execute: async (input) => {
            calls.push({ name: "update", input });
            return { status: "published" };
          },
        }),
      },
      stopWhen: isStepCount(3),
      telemetry: { isEnabled: false },
    });

    await expect(result.text).resolves.toBe("Updated the document section.");
    expect(calls).toEqual([
      { name: "read", input: { taskId, sectionId, revision } },
      {
        name: "update",
        input: { taskId, sectionId, expectedRevision: revision, placement: "replace", markdown },
      },
    ]);
  });
  it.each([
    ["collaborator@example.test", "succeeded", "The connected action succeeded."],
    [
      "uncertain@example.test",
      "uncertain",
      "The connected action’s outcome could not be confirmed. Check Gmail before trying again.",
    ],
  ] as const)(
    "runs the browser connection contract through discovery, schema and exact execution for %s",
    async (recipient, outcome, finalText) => {
      const model = createSimonModels({ ...base, AI_PROVIDER_MODE: "scripted" }).resolve(
        "fast",
      ).model;
      const connectionId = "01234567-89ab-7def-8123-456789abcdef";
      const subject = "Reviewed launch outline";
      const body = "Please review the exact approved outline.";
      const directive = Buffer.from(
        JSON.stringify({ connectionId, recipient, subject, body }),
        "utf8",
      ).toString("base64url");
      const calls: Array<{ name: string; input: unknown }> = [];
      const inputSchema = jsonSchema<Record<string, unknown>>({ type: "object" });
      const result = streamText({
        model,
        prompt: `Prepare the connected action. symplist-e2e-connection-action:${directive}`,
        tools: {
          search_tools: tool({
            inputSchema,
            execute: async (input) => {
              calls.push({ name: "search", input });
              return { results: [{ primary_tool_slugs: ["GMAIL_SEND_EMAIL"] }] };
            },
          }),
          get_tool_schemas: tool({
            inputSchema,
            execute: async (input) => {
              calls.push({ name: "schema", input });
              return { tool: "GMAIL_SEND_EMAIL" };
            },
          }),
          execute_tools: tool({
            inputSchema,
            execute: async (input) => {
              calls.push({ name: "execute", input });
              return { status: outcome };
            },
          }),
        },
        stopWhen: isStepCount(4),
        telemetry: { isEnabled: false },
      });

      await expect(result.text).resolves.toBe(finalText);
      expect(calls).toEqual([
        { name: "search", input: { query: "send an email through Gmail" } },
        { name: "schema", input: { slugs: ["GMAIL_SEND_EMAIL"] } },
        {
          name: "execute",
          input: {
            actions: [
              {
                slug: "GMAIL_SEND_EMAIL",
                connection: connectionId,
                arguments: { recipient, subject, body },
              },
            ],
          },
        },
      ]);
    },
  );
  it("refuses scripted mode in production", () => {
    expect(() =>
      createSimonModels({ ...base, NODE_ENV: "production", AI_PROVIDER_MODE: "scripted" }).resolve(
        "fast",
      ),
    ).toThrow("ai.unavailable");
  });
  it("refuses injected models in ordinary development and production", () => {
    const scripted = vi.fn();
    for (const NODE_ENV of ["production", "development"] as const)
      expect(() => createSimonModels({ ...base, NODE_ENV }, { scripted }).resolve("fast")).toThrow(
        "ai.unavailable",
      );
    expect(scripted).not.toHaveBeenCalled();
  });
  it.each([
    [
      "bedrock",
      "anthropic.claude-sonnet-4-6",
      {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test-key",
        AWS_SECRET_ACCESS_KEY: "test-secret",
      },
    ],
    [
      "vertex",
      "claude-sonnet-4-6",
      {
        GOOGLE_VERTEX_PROJECT: "symplist-test",
        GOOGLE_VERTEX_LOCATION: "us-east5",
        GOOGLE_VERTEX_CREDENTIALS_JSON: "{}",
      },
    ],
    [
      "vertex",
      "gemini-3-flash",
      {
        GOOGLE_VERTEX_PROJECT: "symplist-test",
        GOOGLE_VERTEX_LOCATION: "global",
        GOOGLE_VERTEX_CREDENTIALS_JSON: "{}",
      },
    ],
    ["together", "test/model", { TOGETHER_API_KEY: "test-key" }],
  ] as const)(
    "resolves configured %s/%s without a network call",
    (provider, modelId, credentials) => {
      const fetcher = vi.fn();
      const selected = createSimonModels(
        { ...base, ...credentials, AI_FAST_PROVIDER: provider, AI_FAST_MODEL: modelId },
        { fetch: fetcher },
      ).resolve("fast");
      expect(selected.provider).toBe(provider);
      expect(selected.model.modelId).toBe(modelId);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("forbids provider-hosted tools before any model call", () => {
    expect(() =>
      assertNoProviderExecutedTools({ web: createOpenAI({ apiKey: "test" }).tools.webSearch() }),
    ).toThrow("ai.tool_forbidden");
    expect(() =>
      assertNoProviderExecutedTools({
        native: tool({
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => ({ ok: true }),
        }),
      }),
    ).not.toThrow();
  });
  it("also rejects a provider-hosted tool at the resolved model boundary", async () => {
    const fetcher = vi.fn();
    const selected = createSimonModels(
      { ...base, OPENAI_API_KEY: "test-key" },
      { fetch: fetcher },
    ).resolve("fast");
    await expect(
      generateText({
        model: selected.model,
        prompt: "Hi",
        maxRetries: 0,
        tools: { web: createOpenAI({ apiKey: "test" }).tools.webSearch() },
      }),
    ).rejects.toThrow("ai.tool_forbidden");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
