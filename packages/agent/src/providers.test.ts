import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, jsonSchema, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoProviderExecutedTools,
  createSimonModels,
  type ModelCredentialSource,
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
const owner = "01929f3e-0000-7000-8000-00000000000a";

/** A stand-in for the account's stored key, which is where every live credential now comes from. */
function keyed(
  apiKey: string,
  overrides: Partial<{ provider: "openai" | "anthropic"; model: string }> = {},
): ModelCredentialSource {
  return async (_ownerId, tier) => ({
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? (tier === "fast" ? "gpt-5.6-luna" : "gpt-5.6-terra"),
    apiKey,
  });
}

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
      const models = createSimonModels(base, {
        credentials: keyed("test-not-a-real-key"),
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
      });
      const selected = await models.resolve(tier, owner);
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

  it("never reaches a provider without the account's own key", async () => {
    // An ambient variable is not authority: with no credential source there is nothing to spend.
    vi.stubEnv("OPENAI_API_KEY", "ambient-not-authority");
    const fetcher = vi.fn();
    await expect(
      createSimonModels(base, { fetch: fetcher }).resolve("fast", owner),
    ).rejects.toThrow("ai.unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lets the account's tiers come from different providers", async () => {
    const seen: string[] = [];
    const models = createSimonModels(base, {
      credentials: async (_ownerId, tier) => {
        seen.push(tier);
        return tier === "fast"
          ? { provider: "openai" as const, model: "gpt-5.6-luna", apiKey: "openai-key" }
          : { provider: "anthropic" as const, model: "claude-opus-5-5", apiKey: "anthropic-key" };
      },
    });
    expect(await models.resolve("fast", owner)).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.6-luna",
    });
    expect(await models.resolve("smart", owner)).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    expect(seen).toEqual(["fast", "smart"]);
  });

  it("reads the key every time rather than caching one account's across runs", async () => {
    const credentials = vi.fn<ModelCredentialSource>(keyed("test-key"));
    const models = createSimonModels(base, { credentials });
    await models.resolve("fast", owner);
    await models.resolve("fast", owner);
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it("reports the key as accepted only after the provider answers", async () => {
    const accepted: [string, string][] = [];
    let answered: (() => void) | null = null;
    const models = createSimonModels(base, {
      credentials: keyed("sk-live-0123456789abcd"),
      onAccepted: (ownerId, provider) => accepted.push([ownerId, provider]),
      fetch: async () => {
        // Held open so the assertion below lands while the call is still in flight.
        await new Promise<void>((resolve) => {
          answered = resolve;
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
              content: [{ type: "output_text", text: "Hi", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const selected = await models.resolve("fast", owner);
    const pending = generateText({ model: selected.model, prompt: "hello" });
    await vi.waitFor(() => expect(answered).not.toBeNull());
    // Resolving a model is not evidence: only the provider's answer proves the key is live.
    expect(accepted).toEqual([]);
    (answered as unknown as () => void)();
    await pending;
    expect(accepted).toEqual([[owner, "openai"]]);
  });

  it("does not report a key the provider rejected", async () => {
    const accepted: string[] = [];
    const models = createSimonModels(base, {
      credentials: keyed("sk-wrong-0123456789abc"),
      onAccepted: (_ownerId, provider) => accepted.push(provider),
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const selected = await models.resolve("fast", owner);
    await expect(generateText({ model: selected.model, prompt: "hello" })).rejects.toThrow();
    expect(accepted).toEqual([]);
  });

  it("lets a missing account key travel as itself, not as a model failure", async () => {
    const required = Object.assign(new Error("ai.key_required"), { code: "ai.key_required" });
    const models = createSimonModels(base, {
      credentials: async () => {
        throw required;
      },
    });
    // ai.unavailable means the deployment cannot run models; ai.key_required means this account has
    // not added a key. Flattening the second into the first would send people to the wrong place.
    await expect(models.resolve("fast", owner)).rejects.toBe(required);
  });

  it("disabled AI never falls back to the scripted model", async () => {
    await expect(
      createSimonModels({ ...base, AI_ENABLED: false, AI_PROVIDER_MODE: "scripted" }).resolve(
        "fast",
        owner,
      ),
    ).rejects.toThrow("ai.unavailable");
  });
  it.each(["test", "development"] as const)("runs an explicit script in %s", async (NODE_ENV) => {
    const model = (
      await createSimonModels({ ...base, NODE_ENV, AI_PROVIDER_MODE: "scripted" }).resolve(
        "fast",
        owner,
      )
    ).model;
    expect(
      await streamText({ model, prompt: "Hi", telemetry: { isEnabled: false } }).text,
    ).toContain("Scripted development");
  });
  it("runs the browser document contract through two separate scripted tool steps", async () => {
    const model = (
      await createSimonModels({ ...base, AI_PROVIDER_MODE: "scripted" }).resolve("fast", owner)
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
      const model = (
        await createSimonModels({ ...base, AI_PROVIDER_MODE: "scripted" }).resolve("fast", owner)
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
  it("refuses scripted mode in production", async () => {
    await expect(
      createSimonModels({ ...base, NODE_ENV: "production", AI_PROVIDER_MODE: "scripted" }).resolve(
        "fast",
        owner,
      ),
    ).rejects.toThrow("ai.unavailable");
  });
  it("refuses injected models in ordinary development and production", async () => {
    const scripted = vi.fn();
    for (const NODE_ENV of ["production", "development"] as const)
      await expect(
        createSimonModels({ ...base, NODE_ENV }, { scripted }).resolve("fast", owner),
      ).rejects.toThrow("ai.unavailable");
    expect(scripted).not.toHaveBeenCalled();
  });
  it.each([
    ["openai", "gpt-5.6-luna"],
    ["anthropic", "claude-opus-5-5"],
  ] as const)("builds a %s client for %s without a network call", async (provider, modelId) => {
    const fetcher = vi.fn();
    const selected = await createSimonModels(base, {
      fetch: fetcher,
      credentials: async () => ({ provider, model: modelId, apiKey: "test-key" }),
    }).resolve("fast", owner);
    expect(selected.provider).toBe(provider);
    expect(selected.model.modelId).toBe(modelId);
    expect(fetcher).not.toHaveBeenCalled();
  });

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
    const selected = await createSimonModels(base, {
      fetch: fetcher,
      credentials: keyed("test-key"),
    }).resolve("fast", owner);
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
