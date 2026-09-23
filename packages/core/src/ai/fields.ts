import type { AiProvider } from "@symplist/contracts";
import type { FieldEnvelopeContext } from "@symplist/crypto";

/**
 * The binding for a stored provider key (§4.2).
 *
 * The provider is the row id, so an envelope sealed for one provider cannot be opened as another:
 * moving an Anthropic key into the OpenAI row would send a live credential to the wrong company,
 * which is the kind of mistake that has to fail closed rather than merely be unlikely.
 */
export function providerKeyContext(ownerId: string, provider: AiProvider): FieldEnvelopeContext {
  return Object.freeze({
    purpose: "ai_provider_key",
    ownerId,
    table: "ai_provider_keys",
    rowId: provider,
    column: "key_enc",
  });
}
