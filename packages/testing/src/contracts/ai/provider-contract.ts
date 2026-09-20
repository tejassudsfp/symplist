import type { LanguageModel } from "ai";
import { generateText, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A model plus the observations needed by the provider contract. */
export interface AiProviderContractSubject {
  readonly model: LanguageModel;
  readonly provider: string;
  readonly modelId: string;
  /** Call options recorded by deterministic models; live targets may omit this. */
  readonly calls?: readonly unknown[];
  /** A provider-specific check for the no-provider-tools rule. */
  readonly assertNoProviderTools?: () => void;
  /** A stable error boundary for a provider failure, when the adapter exposes one. */
  readonly normalizeError?: (error: unknown) => { readonly code: string };
  /** Synthetic text expected from a deterministic target. */
  readonly expectedText?: string;
}

export interface AiProviderContractTarget {
  readonly name: string;
  /** Set for live targets when the flag or credential is absent. */
  readonly skipReason?: string;
  /** Network-backed targets may opt into a longer deadline without weakening scripted targets. */
  readonly testTimeoutMs?: number;
  readonly create: () => Promise<AiProviderContractSubject> | AiProviderContractSubject;
}

export interface LiveOpenAiSettings {
  readonly apiKey: string;
  readonly model: string;
}

/** Resolve live OpenAI settings without ever printing the key. */
export function liveOpenAiSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly settings: LiveOpenAiSettings } | { readonly skipReason: string } {
  if (env.LIVE_OPENAI !== "1")
    return { skipReason: "set LIVE_OPENAI=1 to run the bounded live OpenAI contract" };
  if (!env.OPENAI_API_KEY) return { skipReason: "LIVE_OPENAI=1 but OPENAI_API_KEY missing" };
  return {
    settings: {
      apiKey: env.OPENAI_API_KEY,
      model: env.LIVE_OPENAI_MODEL ?? "gpt-5.6-luna",
    },
  };
}

/**
 * Provider contract (§8.3, §8.6, §17). The suite deliberately sends only a short synthetic marker,
 * disables SDK telemetry and retries at the call boundary, bounds the response, and checks the
 * adapter's tool/error privacy hooks when supplied. Live targets must use a model with no tools and
 * are skipped visibly unless LIVE_OPENAI=1 and a key are present.
 */
export function describeAiProviderContract(target: AiProviderContractTarget): void {
  const title = `AI provider contract: ${target.name}${target.skipReason ? ` (skipped: ${target.skipReason})` : ""}`;
  describe.skipIf(target.skipReason !== undefined)(title, { timeout: target.testTimeoutMs }, () => {
    let subject: AiProviderContractSubject;
    const marker = "symplist-contract-marker-7f9d";
    let logs: ReturnType<typeof vi.spyOn>[];

    beforeEach(async () => {
      logs = [
        vi.spyOn(console, "error"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "info"),
        vi.spyOn(console, "debug"),
      ];
      subject = await target.create();
    }, target.testTimeoutMs);

    afterEach(() => {
      for (const log of logs) {
        for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain(marker);
        log.mockRestore();
      }
    });

    it("returns bounded synthetic output with telemetry disabled and no retries", async () => {
      const result = await generateText({
        model: subject.model,
        prompt: marker,
        maxOutputTokens: 64,
        maxRetries: 0,
        telemetry: { isEnabled: false },
      });
      expect(result.text.length).toBeLessThanOrEqual(16_384);
      if (subject.expectedText !== undefined) expect(result.text).toBe(subject.expectedText);
      if (subject.calls !== undefined) {
        expect(subject.calls.length).toBeGreaterThan(0);
        expect(JSON.stringify(subject.calls)).not.toContain("telemetry");
      }
    });

    it("streams a bounded response without content-bearing console logs", async () => {
      const result = await streamText({
        model: subject.model,
        prompt: marker,
        maxOutputTokens: 64,
        maxRetries: 0,
        telemetry: { isEnabled: false },
        // The SDK default console handler serializes provider errors, including request input.
        // Production always replaces it with a stable-code handler; the contract must do the same.
        onError: () => {},
      });
      const text = await result.text;
      expect(text.length).toBeLessThanOrEqual(16_384);
      expect(text).not.toContain("OPENAI_API_KEY");
    });

    it("exposes stable provider/model identity without a credential or response body", () => {
      expect(subject.provider).toMatch(/^[a-z][a-z0-9_.-]{1,63}$/);
      expect(subject.modelId).toMatch(/^.{1,256}$/);
      expect(subject.provider).not.toContain("sk-");
      expect(subject.modelId).not.toContain("sk-");
    });

    it("rejects provider-executed tools at the adapter boundary when exposed", () => {
      if (subject.assertNoProviderTools) subject.assertNoProviderTools();
    });

    it("normalizes provider failures to a stable code without retaining the body when exposed", () => {
      if (!subject.normalizeError) return;
      const error = subject.normalizeError(new Error(marker));
      expect(error.code).toMatch(/^(ai|integration)\.[a-z_]+$/);
      expect(JSON.stringify(error)).not.toContain(marker);
    });
  });
}
