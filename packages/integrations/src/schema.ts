import type { Composio } from "@composio/core";
import { IntegrationError, normalizeIntegrationError } from "./errors.ts";
import type { ExternalToolSchema } from "./execution.ts";

/** Canonical toolkit and schema come from SDK metadata, never a guessed slug prefix. */
export async function readExternalToolSchema(
  client: Composio,
  slug: string,
): Promise<ExternalToolSchema> {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(slug) || slug.startsWith("COMPOSIO_"))
    throw new IntegrationError("integration.tool_unavailable");
  try {
    const tool = await client.tools.getRawComposioToolBySlug(slug);
    const toolkit = tool.toolkit?.slug;
    if (
      tool.slug !== slug ||
      tool.isDeprecated ||
      !toolkit ||
      !tool.inputParameters ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(toolkit)
    )
      throw new IntegrationError("integration.tool_unavailable");
    const encoded = JSON.stringify(tool.inputParameters);
    if (Buffer.byteLength(encoded) > 64_000)
      throw new IntegrationError("integration.invalid_response");
    return {
      slug,
      toolkit,
      description: (tool.description ?? tool.name).slice(0, 2000),
      schema: JSON.parse(encoded) as Record<string, unknown>,
      tags: {
        readOnlyHint: tool.tags?.includes("readOnlyHint") ?? false,
        destructiveHint: tool.tags?.includes("destructiveHint") ?? false,
      },
    };
  } catch (error) {
    throw normalizeIntegrationError(error);
  }
}
