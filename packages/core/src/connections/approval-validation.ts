import {
  type ConnectionToolAuthority,
  type ExternalToolSchema,
  IntegrationError,
  maskVaultHandles,
  normalizeIntegrationError,
  validateExternalArguments,
} from "@symplist/integrations";
import type { ApprovalEditValidator } from "../simon/approvals.ts";

export interface ApprovalValidationOptions {
  readonly authority: ConnectionToolAuthority;
  /** Inject the reviewed pure policy module, never the agent runtime or an upstream decision. */
  readonly actionPolicy: (
    slug: string,
    argumentsValue: unknown,
    discovered: readonly ExternalToolSchema[],
  ) => "approval_required" | "exempt" | "unavailable";
  readonly policyVersion: string | (() => string);
}

/** Metadata-only: safe to call in the durable API. Creates no session and executes no tool. */
export function createApprovalEditValidator(
  options: ApprovalValidationOptions,
): ApprovalEditValidator {
  return async ({ approval, editedArguments }) => {
    const { authority } = options;
    if (!(await authority.check())) throw new IntegrationError("integration.unauthorized");
    if (
      !/^[A-Z][A-Z0-9_]{1,127}$/.test(approval.toolSlug) ||
      approval.toolSlug.startsWith("COMPOSIO_")
    )
      throw new IntegrationError("integration.tool_unavailable");
    let tool: ExternalToolSchema;
    try {
      tool = await authority.schema(approval.toolSlug);
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    if (tool.slug !== approval.toolSlug) throw new IntegrationError("integration.invalid_response");
    const args = validateExternalArguments(tool.schema, editedArguments, {
      allowVaultHandles: true,
    });
    const connection = (await authority.connections()).find(
      (item) => item.id === approval.connectionId,
    );
    if (
      !connection ||
      connection.ownerId !== authority.ownerId ||
      connection.toolkit !== tool.toolkit ||
      connection.connectedAccountId !== approval.connectedAccountId ||
      connection.generation !== approval.connectionGeneration
    )
      throw new IntegrationError("integration.connection_required");
    const policy = options.actionPolicy(tool.slug, args, [tool]);
    if (policy === "unavailable") throw new IntegrationError("integration.tool_unavailable");
    const policyVersion =
      typeof options.policyVersion === "function" ? options.policyVersion() : options.policyVersion;
    if (!policyVersion || policyVersion.length > 128)
      throw new IntegrationError("integration.unavailable");
    // The deciding approval write rechecks connection/admission authority. This final read also
    // refuses a relock during the metadata request before any preview is returned to the user.
    if (!(await authority.check())) throw new IntegrationError("integration.unauthorized");
    return {
      arguments: args,
      policyVersion,
      preview: {
        tool: tool.slug,
        toolkit: tool.toolkit,
        connection: connection.id,
        policy,
        arguments: maskVaultHandles(args),
      },
    };
  };
}
