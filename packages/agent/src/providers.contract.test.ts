import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  type AiProviderContractSubject,
  createScriptedModel,
  describeAiProviderContract,
  liveOpenAiSettings,
  scriptedText,
} from "@symplist/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoProviderExecutedTools,
  createSimonModels,
  type SimonModelConfig,
} from "./providers.ts";

const base: SimonModelConfig = {
  NODE_ENV: "test",
  AI_ENABLED: true,
  AI_PROVIDER_MODE: "scripted",
  AI_FAST_PROVIDER: "openai",
  AI_FAST_MODEL: "gpt-5.6-luna",
  AI_SMART_PROVIDER: "openai",
  AI_SMART_MODEL: "gpt-5.6-terra",
};

function scriptedTarget(): AiProviderContractSubject {
  const marker = "symplist-contract-marker-7f9d";
  const script = createScriptedModel([scriptedText(marker)], {
    provider: "symplist.scripted",
    modelId: "scripted-contract",
  });
  const selected = createSimonModels(
    { ...base, AI_PROVIDER_MODE: "scripted" },
    { scripted: () => script.model },
  ).resolve("fast");
  return {
    model: selected.model,
    provider: selected.provider,
    modelId: selected.modelId,
    calls: script.calls,
    expectedText: marker,
    assertNoProviderTools: () =>
      expect(() =>
        assertNoProviderExecutedTools({
          remote: createOpenAI({ apiKey: "test-only" }).tools.webSearch(),
        }),
      ).toThrow("ai.tool_forbidden"),
  };
}

describeAiProviderContract({
  name: "scripted model",
  create: scriptedTarget,
});

const live = liveOpenAiSettings();
describeAiProviderContract({
  name: "OpenAI Responses",
  skipReason: "skipReason" in live ? live.skipReason : undefined,
  testTimeoutMs: 30_000,
  create: () => {
    if (!("settings" in live)) throw new Error("live OpenAI target was skipped");
    const config: SimonModelConfig = {
      ...base,
      NODE_ENV: "test",
      AI_PROVIDER_MODE: "live",
      AI_FAST_PROVIDER: "openai",
      AI_FAST_MODEL: live.settings.model,
      AI_SMART_PROVIDER: "openai",
      AI_SMART_MODEL: live.settings.model,
      OPENAI_API_KEY: live.settings.apiKey,
    };
    const selected = createSimonModels(config).resolve("fast");
    return {
      model: selected.model,
      provider: selected.provider,
      modelId: selected.modelId,
      assertNoProviderTools: () =>
        expect(() =>
          assertNoProviderExecutedTools({
            remote: createOpenAI({ apiKey: "test-only" }).tools.webSearch(),
          }),
        ).toThrow("ai.tool_forbidden"),
    };
  },
});

describe.skipIf("skipReason" in live)("OpenAI live prompt-cache telemetry", () => {
  it(
    "reuses an eligible stable conversation prefix and reports cached input tokens",
    { timeout: 45_000 },
    async () => {
      if (!("settings" in live)) throw new Error("live OpenAI target was skipped");
      const selected = createSimonModels({
        ...base,
        NODE_ENV: "test",
        AI_PROVIDER_MODE: "live",
        AI_FAST_PROVIDER: "openai",
        AI_FAST_MODEL: live.settings.model,
        AI_SMART_PROVIDER: "openai",
        AI_SMART_MODEL: live.settings.model,
        OPENAI_API_KEY: live.settings.apiKey,
      }).resolve("fast");
      const stablePrefix = Array.from(
        { length: 1_600 },
        (_, index) => `cache-contract-token-${index % 16}`,
      ).join(" ");
      let cacheReadTokens = 0;
      for (let attempt = 0; attempt < 3 && cacheReadTokens === 0; attempt += 1) {
        const result = await generateText({
          model: selected.model,
          instructions: stablePrefix,
          prompt: "Reply with OK.",
          maxOutputTokens: 16,
          maxRetries: 0,
          telemetry: { isEnabled: false },
        });
        cacheReadTokens = Math.max(
          cacheReadTokens,
          result.usage.inputTokenDetails.cacheReadTokens ?? 0,
        );
      }
      expect(cacheReadTokens).toBeGreaterThan(0);
    },
  );
});

describe("AI live-contract gating", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports a visible reason when the live flag is absent without exposing a key", () => {
    const result = liveOpenAiSettings({ OPENAI_API_KEY: "sk-secret-test" });
    expect(result).toEqual({
      skipReason: "set LIVE_OPENAI=1 to run the bounded live OpenAI contract",
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret-test");
  });

  it("does not include the key in the skip reason when credentials are missing", () => {
    const result = liveOpenAiSettings({ LIVE_OPENAI: "1" });
    expect(result).toEqual({ skipReason: "LIVE_OPENAI=1 but OPENAI_API_KEY missing" });
  });
});
