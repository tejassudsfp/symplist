import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AiProvider, AiTier, NodeEnv, SharedRuntimeConfig } from "@symplist/config";
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
> & { readonly NODE_ENV: NodeEnv };

/**
 * The account's key and chosen model for a tier (§8.6).
 *
 * Model credentials are the account's, not the deployment's, so they arrive per run rather than
 * from configuration. The returned key is used for one call and not retained: there is no cache of
 * decrypted credentials anywhere in this module, which is why `resolve` is asynchronous.
 */
export interface ModelCredential {
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiKey: string;
}

/**
 * Told that a provider accepted an account's key on a real call.
 *
 * This is the only moment anyone learns a key is live: validation on the way in checks shape, and
 * only the provider can say the rest. It fires after a successful call, never on the way to one.
 */
export type ModelAcceptedSink = (ownerId: string, provider: AiProvider) => void;

/** Looks up the credential an owner's tier runs with. Throws `ai.key_required` when there is none. */
export type ModelCredentialSource = (ownerId: string, tier: AiTier) => Promise<ModelCredential>;

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
      },
    };
  },
};

/**
 * Reports the first successful call on a live key.
 *
 * Acceptance is only knowable from the provider's side of the call, so it is observed here rather
 * than inferred from the turn finishing: a turn can end for many reasons that say nothing about the
 * credential. Streaming counts as accepted once the provider has returned a stream — an auth
 * failure never gets that far — so a long generation confirms the key without waiting for its end.
 */
function acceptanceMiddleware(report: () => void): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      report();
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      report();
      return result;
    },
  };
}

export interface SelectedSimonModel {
  readonly provider: AiProvider | "scripted";
  readonly modelId: string;
  readonly model: SimonModel;
}

function supportsModernOpenAiPromptCache(modelId: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:[-.]|$)/u.exec(modelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

/**
 * The model each tier runs with.
 *
 * Credentials belong to the account, so they are fetched per run through `credentials` and never
 * cached here: a cache keyed by tier would hand one account's key to the next run, and a cache keyed
 * by owner would keep decrypted keys alive between turns for no benefit worth that. Building the
 * client is cheap; the read is the cost, and it is one read per turn.
 *
 * The scripted path is the exception, and only in test and development: it needs no credential
 * because it never reaches a provider.
 */
export function createSimonModels(
  config: SimonModelConfig,
  options: {
    readonly fetch?: typeof fetch;
    readonly scripted?: (tier: AiTier) => SimonModel;
    /** Absent only where no live call is possible, which is the scripted path. */
    readonly credentials?: ModelCredentialSource;
    /** Notified when a provider accepts the key, so the settings screen can say it works. */
    readonly onAccepted?: ModelAcceptedSink;
  } = {},
): { resolve(tier: AiTier, ownerId: string): Promise<SelectedSimonModel> } {
  // Provider warnings can include request content. Never let the SDK write them to process warnings.
  globalThis.AI_SDK_LOG_WARNINGS = false;
  return {
    async resolve(tier, ownerId) {
      if (!config.AI_ENABLED) throw new SimonModelError("ai.unavailable");
      const scripted = config.AI_PROVIDER_MODE === "scripted" || options.scripted !== undefined;
      if (
        scripted &&
        !(
          config.NODE_ENV === "test" ||
          (config.NODE_ENV === "development" && config.AI_PROVIDER_MODE === "scripted")
        )
      )
        throw new SimonModelError("ai.unavailable");
      if (!scripted && !options.credentials) throw new SimonModelError("ai.unavailable");
      // `credentials` throws ai.key_required when this account has not added a key. That is not a
      // model failure and must not be flattened into ai.unavailable, so it is resolved outside the
      // try below and allowed to travel to the caller intact.
      const credential = scripted
        ? null
        : await (options.credentials as ModelCredentialSource)(ownerId, tier);
      const provider: AiProvider | "scripted" = credential?.provider ?? "scripted";
      const modelId = credential?.model ?? "scripted";
      let model: SimonModel;
      const transport = options.fetch ? { fetch: options.fetch } : {};
      try {
        switch (provider) {
          case "scripted":
            model = options.scripted?.(tier) ?? developmentModel();
            break;
          case "openai":
            model = createOpenAI({
              apiKey: (credential as ModelCredential).apiKey,
              baseURL: "https://api.openai.com/v1",
              ...transport,
            }).responses(modelId);
            break;
          case "anthropic":
            model = createAnthropic({
              apiKey: (credential as ModelCredential).apiKey,
              baseURL: "https://api.anthropic.com/v1",
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
                    ...(provider === "openai" && supportsModernOpenAiPromptCache(modelId)
                      ? { promptCacheOptions: { mode: "implicit" as const, ttl: "30m" as const } }
                      : {}),
                  },
                  anthropic: { disableParallelToolUse: true },
                },
              },
            }),
            privacyMiddleware,
            // Scripted models reach no provider, so there is nothing for them to confirm.
            ...(credential && options.onAccepted
              ? [
                  acceptanceMiddleware(() =>
                    (options.onAccepted as ModelAcceptedSink)(ownerId, credential.provider),
                  ),
                ]
              : []),
          ],
        });
        const registry = createProviderRegistry({
          [provider]: customProvider({ languageModels: { [tier]: wrapped } }),
        });
        return {
          provider,
          modelId,
          model: registry.languageModel(`${provider}:${tier}`),
        };
      } catch {
        throw new SimonModelError("ai.unavailable");
      }
    },
  };
}

const DOCUMENT_EDIT_DIRECTIVE = "symplist-e2e-document-edit:";
const CONNECTION_ACTION_DIRECTIVE = "symplist-e2e-connection-action:";

interface DevelopmentDocumentEdit {
  readonly taskId: string;
  readonly sectionId: string;
  readonly revision: string;
  readonly markdown: string;
}

interface DevelopmentConnectionAction {
  readonly connectionId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function developmentDocumentEdit(prompt: unknown): DevelopmentDocumentEdit | null {
  const text = stringsIn(prompt).find((value) => value.includes(DOCUMENT_EDIT_DIRECTIVE));
  if (!text) return null;
  const encoded = text
    .slice(text.indexOf(DOCUMENT_EDIT_DIRECTIVE) + DOCUMENT_EDIT_DIRECTIVE.length)
    .trim()
    .split(/\s/, 1)[0];
  if (!encoded) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof value.taskId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.taskId) ||
      typeof value.sectionId !== "string" ||
      !/^s[A-Za-z0-9_-]{25}$/.test(value.sectionId) ||
      typeof value.revision !== "string" ||
      !/^[0-9a-f]{40}$/.test(value.revision) ||
      typeof value.markdown !== "string" ||
      value.markdown.length > 65_536
    )
      return null;
    return {
      taskId: value.taskId,
      sectionId: value.sectionId,
      revision: value.revision,
      markdown: value.markdown,
    };
  } catch {
    return null;
  }
}

function developmentConnectionAction(prompt: unknown): DevelopmentConnectionAction | null {
  const text = stringsIn(prompt).find((value) => value.includes(CONNECTION_ACTION_DIRECTIVE));
  if (!text) return null;
  const encoded = text
    .slice(text.indexOf(CONNECTION_ACTION_DIRECTIVE) + CONNECTION_ACTION_DIRECTIVE.length)
    .trim()
    .split(/\s/, 1)[0];
  if (!encoded) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof value.connectionId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.connectionId) ||
      typeof value.recipient !== "string" ||
      value.recipient.length < 3 ||
      value.recipient.length > 320 ||
      typeof value.subject !== "string" ||
      value.subject.length < 1 ||
      value.subject.length > 998 ||
      typeof value.body !== "string" ||
      value.body.length < 1 ||
      value.body.length > 32_000
    )
      return null;
    return {
      connectionId: value.connectionId,
      recipient: value.recipient,
      subject: value.subject,
      body: value.body,
    };
  } catch {
    return null;
  }
}

function developmentStream(prompt: unknown): Awaited<ReturnType<SimonModel["doStream"]>> {
  const documentDirective = developmentDocumentEdit(prompt);
  const connectionDirective = developmentConnectionAction(prompt);
  const serialized = JSON.stringify(prompt) ?? "";
  const readFinished = serialized.includes('"toolName":"task_document_read_section"');
  const updateFinished = serialized.includes('"toolName":"task_document_update_section"');
  const searchFinished = serialized.includes('"toolName":"search_tools"');
  const schemaFinished = serialized.includes('"toolName":"get_tool_schemas"');
  const executeFinished = serialized.includes('"toolName":"execute_tools"');
  const tool =
    documentDirective && !readFinished
      ? {
          id: "scripted_document_read",
          name: "task_document_read_section",
          input: {
            taskId: documentDirective.taskId,
            sectionId: documentDirective.sectionId,
            revision: documentDirective.revision,
          },
        }
      : documentDirective && !updateFinished
        ? {
            id: "scripted_document_update",
            name: "task_document_update_section",
            input: {
              taskId: documentDirective.taskId,
              sectionId: documentDirective.sectionId,
              expectedRevision: documentDirective.revision,
              placement: "replace",
              markdown: documentDirective.markdown,
            },
          }
        : connectionDirective && !searchFinished
          ? {
              id: "scripted_connection_search",
              name: "search_tools",
              input: { query: "send an email through Gmail" },
            }
          : connectionDirective && !schemaFinished
            ? {
                id: "scripted_connection_schema",
                name: "get_tool_schemas",
                input: { slugs: ["GMAIL_SEND_EMAIL"] },
              }
            : connectionDirective && !executeFinished
              ? {
                  id: "scripted_connection_execute",
                  name: "execute_tools",
                  input: {
                    actions: [
                      {
                        slug: "GMAIL_SEND_EMAIL",
                        connection: connectionDirective.connectionId,
                        arguments: {
                          recipient: connectionDirective.recipient,
                          subject: connectionDirective.subject,
                          body: connectionDirective.body,
                        },
                      },
                    ],
                  },
                }
              : null;
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (tool) {
          const input = JSON.stringify(tool.input);
          controller.enqueue({ type: "tool-input-start", id: tool.id, toolName: tool.name });
          controller.enqueue({ type: "tool-input-delta", id: tool.id, delta: input });
          controller.enqueue({ type: "tool-input-end", id: tool.id });
          controller.enqueue({
            type: "tool-call",
            toolCallId: tool.id,
            toolName: tool.name,
            input,
          });
        } else {
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: documentDirective
              ? "Updated the document section."
              : connectionDirective
                ? serialized.includes('"status":"uncertain"')
                  ? "The connected action’s outcome could not be confirmed. Check Gmail before trying again."
                  : serialized.includes('"status":"denied"') ||
                      serialized.includes('"status":"dismissed"') ||
                      serialized.includes('"status":"expired"')
                    ? "The connected action was not sent."
                    : "The connected action succeeded."
                : "Scripted development response. No model or external action was called.",
          });
          controller.enqueue({ type: "text-end", id: "text" });
        }
        controller.enqueue({
          type: "finish",
          finishReason: { unified: tool ? "tool-calls" : "stop", raw: undefined },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
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
    doStream: async ({ prompt }) => developmentStream(prompt),
  };
}
