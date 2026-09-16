import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createGoogleVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import type {
  AiProvider,
  AiProviderCredentials,
  AiTier,
  NodeEnv,
  SharedRuntimeConfig,
} from "@symplist/config";
import {
  createProviderRegistry,
  customProvider,
  defaultSettingsMiddleware,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ToolSet,
  wrapLanguageModel,
} from "ai";

export type SimonModel = Extract<LanguageModel, { specificationVersion: "v4" }>;
export type SimonModelConfig = Pick<
  SharedRuntimeConfig,
  | "AI_ENABLED"
  | "AI_PROVIDER_MODE"
  | "AI_FAST_PROVIDER"
  | "AI_FAST_MODEL"
  | "AI_SMART_PROVIDER"
  | "AI_SMART_MODEL"
> &
  AiProviderCredentials & { readonly NODE_ENV: NodeEnv };

export class SimonModelError extends Error {
  constructor(
    readonly code:
      | "ai.unavailable"
      | "ai.tool_forbidden"
      | "ai.provider_failed"
      | "ai.invalid_history",
  ) {
    super(code);
    this.name = "SimonModelError";
  }
}

export function assertNoProviderExecutedTools(tools: ToolSet): void {
  if (Object.values(tools).some((tool) => tool.type === "provider"))
    throw new SimonModelError("ai.tool_forbidden");
}

/** These are invariants, not caller-overridable preferences. Defaults still use the SDK middleware. */
const privacyMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => {
    if (params.tools?.some((tool) => tool.type !== "function"))
      throw new SimonModelError("ai.tool_forbidden");
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        openai: {
          ...params.providerOptions?.openai,
          store: false,
          reasoningSummary: null,
          parallelToolCalls: false,
        },
        anthropic: { ...params.providerOptions?.anthropic, disableParallelToolUse: true },
        togetherai: { ...params.providerOptions?.togetherai, parallelToolCalls: false },
      },
    };
  },
};

export interface SelectedSimonModel {
  readonly provider: AiProvider | "scripted";
  readonly modelId: string;
  readonly model: SimonModel;
}

/** Credentials come only from validated configuration; no ambient SDK gateway or fallback. */
export function createSimonModels(
  config: SimonModelConfig,
  options: {
    readonly fetch?: typeof fetch;
    readonly scripted?: (tier: AiTier) => SimonModel;
  } = {},
): { resolve(tier: AiTier): SelectedSimonModel } {
  // Provider warnings can include request content. Never let the SDK write them to process warnings.
  globalThis.AI_SDK_LOG_WARNINGS = false;
  const cache = new Map<AiTier, SelectedSimonModel>();
  return {
    resolve(tier) {
      if (!config.AI_ENABLED) throw new SimonModelError("ai.unavailable");
      const cached = cache.get(tier);
      if (cached) return cached;
      const scripted = config.AI_PROVIDER_MODE === "scripted" || options.scripted !== undefined;
      if (
        scripted &&
        !(
          config.NODE_ENV === "test" ||
          (config.NODE_ENV === "development" && config.AI_PROVIDER_MODE === "scripted")
        )
      )
        throw new SimonModelError("ai.unavailable");
      const provider = scripted
        ? "scripted"
        : tier === "fast"
          ? config.AI_FAST_PROVIDER
          : config.AI_SMART_PROVIDER;
      const modelId = scripted
        ? "scripted"
        : tier === "fast"
          ? config.AI_FAST_MODEL
          : config.AI_SMART_MODEL;
      let model: SimonModel;
      const transport = options.fetch ? { fetch: options.fetch } : {};
      try {
        switch (provider) {
          case "scripted":
            model = options.scripted?.(tier) ?? developmentModel();
            break;
          case "openai":
            if (!config.OPENAI_API_KEY) throw new SimonModelError("ai.unavailable");
            model = createOpenAI({
              apiKey: config.OPENAI_API_KEY,
              baseURL: "https://api.openai.com/v1",
              ...transport,
            }).responses(modelId);
            break;
          case "bedrock":
            if (!config.AWS_REGION || !config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY)
              throw new SimonModelError("ai.unavailable");
            model = createAmazonBedrockAnthropic({
              region: config.AWS_REGION,
              accessKeyId: config.AWS_ACCESS_KEY_ID,
              secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
              apiKey: "",
              sessionToken: "",
              baseURL: `https://bedrock-runtime.${config.AWS_REGION}.amazonaws.com`,
              ...transport,
            })(modelId);
            break;
          case "vertex": {
            if (
              !config.GOOGLE_VERTEX_PROJECT ||
              !config.GOOGLE_VERTEX_LOCATION ||
              !config.GOOGLE_VERTEX_CREDENTIALS_JSON
            )
              throw new SimonModelError("ai.unavailable");
            const vertexOptions = {
              project: config.GOOGLE_VERTEX_PROJECT,
              location: config.GOOGLE_VERTEX_LOCATION,
              googleAuthOptions: { credentials: JSON.parse(config.GOOGLE_VERTEX_CREDENTIALS_JSON) },
              ...transport,
            };
            model = modelId.startsWith("claude")
              ? createGoogleVertexAnthropic(vertexOptions)(modelId)
              : createGoogleVertex({ ...vertexOptions, apiKey: "" })(modelId);
            break;
          }
          case "together":
            if (!config.TOGETHER_API_KEY) throw new SimonModelError("ai.unavailable");
            model = createTogetherAI({
              apiKey: config.TOGETHER_API_KEY,
              baseURL: "https://api.together.xyz/v1",
              ...transport,
            })(modelId);
            break;
        }
        const wrapped = wrapLanguageModel({
          model,
          middleware: [
            defaultSettingsMiddleware({
              settings: {
                providerOptions: {
                  openai: {
                    reasoningEffort: tier === "fast" ? "low" : "medium",
                    reasoningSummary: null,
                    store: false,
                    parallelToolCalls: false,
                  },
                },
              },
            }),
            privacyMiddleware,
          ],
        });
        const registry = createProviderRegistry({
          [provider]: customProvider({ languageModels: { [tier]: wrapped } }),
        });
        const selected: SelectedSimonModel = {
          provider,
          modelId,
          model: registry.languageModel(`${provider}:${tier}`),
        };
        cache.set(tier, selected);
        return selected;
      } catch {
        throw new SimonModelError("ai.unavailable");
      }
    },
  };
}

/** Explicit development mode only: no inference from a missing production credential. */
function developmentModel(): SimonModel {
  return {
    specificationVersion: "v4",
    provider: "symplist.scripted",
    modelId: "scripted",
    supportedUrls: {},
    doGenerate: async () => {
      throw new SimonModelError("ai.unavailable");
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: "Scripted development response. No model or external action was called.",
          });
          controller.enqueue({ type: "text-end", id: "text" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  };
}
