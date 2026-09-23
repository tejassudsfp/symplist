"use client";

import {
  type AiModelChoicesInput,
  type AiProvider,
  type AiSettings,
  aiSettingsSchema,
} from "@symplist/contracts";
import { type ApiClient, getApiClient } from "@/lib/api";

/**
 * The browser side of each account's model keys (§8.6).
 *
 * There is no `getKey`. The api has no route that returns one and this interface has no method that
 * could call it, so the key a person types leaves the browser once and is never fetched back — the
 * screen renders from `configured` and dates alone.
 */
export interface AiSettingsApi {
  settings(signal: AbortSignal): Promise<AiSettings>;
  setKey(provider: AiProvider, key: string, signal: AbortSignal): Promise<void>;
  clearKey(provider: AiProvider, signal: AbortSignal): Promise<void>;
  setModels(body: AiModelChoicesInput, signal: AbortSignal): Promise<AiSettings>;
}

export function createAiSettingsApi(client: () => ApiClient = getApiClient): AiSettingsApi {
  return {
    settings: (signal) => client().get("/v1/ai", { signal, schema: aiSettingsSchema }),
    setKey: async (provider, key, signal) => {
      await client().put(`/v1/ai/keys/${provider}`, { body: { key }, signal });
    },
    clearKey: async (provider, signal) => {
      await client().delete(`/v1/ai/keys/${provider}`, { signal });
    },
    setModels: (body, signal) =>
      client().put("/v1/ai/models", { body, signal, schema: aiSettingsSchema }),
  };
}
