import type { ConnectionToolAuthority, ExternalToolSchema } from "@symplist/integrations";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalView } from "../simon/approvals.ts";
import { createApprovalEditValidator } from "./approval-validation.ts";

function fixture() {
  const tool: ExternalToolSchema = {
    slug: "MAIL_SEND",
    toolkit: "mail",
    description: "untrusted provider prose",
    schema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    },
    tags: { readOnlyHint: false, destructiveHint: false },
  };
  const connection = {
    id: "connection",
    ownerId: "owner",
    toolkit: "mail",
    connectedAccountId: "ca_1",
    generation: 2,
  };
  const authority: ConnectionToolAuthority = {
    ownerId: "owner",
    check: vi.fn(async () => true),
    connections: vi.fn(async () => [connection]),
    schema: vi.fn(async () => tool),
  };
  const approval: ApprovalView = {
    id: "approval",
    runId: "run",
    toolCallId: "call",
    toolSlug: tool.slug,
    connectionId: connection.id,
    connectedAccountId: connection.connectedAccountId,
    connectionToolkit: connection.toolkit,
    connectionAlias: null,
    connectionGeneration: 2,
    status: "pending",
    argDigest: "digest",
    arguments: { body: "old" },
    preview: { misleading: "old" },
    expiresAt: 1234,
    policyVersion: "old",
  };
  const actionPolicy = vi.fn(() => "approval_required" as const);
  const validate = createApprovalEditValidator({
    authority,
    actionPolicy,
    policyVersion: () => "new",
  });
  return { tool, connection, authority, approval, actionPolicy, validate };
}

describe("metadata-only approval edit validation", () => {
  it("validates fresh schemas and policy, ignores old previews and strips identity selectors", async () => {
    const f = fixture();
    const result = await f.validate({
      approval: f.approval,
      editedArguments: { body: "edited", account: "attacker" },
    });
    expect(result).toEqual({
      arguments: { body: "edited" },
      policyVersion: "new",
      preview: {
        tool: "MAIL_SEND",
        toolkit: "mail",
        connection: "connection",
        policy: "approval_required",
        arguments: { body: "edited" },
      },
    });
    expect(f.actionPolicy).toHaveBeenCalledWith("MAIL_SEND", { body: "edited" }, [f.tool]);
    expect(f.authority.check).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("untrusted provider prose");
  });

  it.each([
    { ownerId: "attacker" },
    { generation: 3 },
    { connectedAccountId: "ca_other" },
    { toolkit: "other" },
    { id: "other" },
  ])("rejects changed connection authority %j", async (change) => {
    const f = fixture();
    Object.assign(f.connection, change);
    await expect(
      f.validate({ approval: f.approval, editedArguments: { body: "edited" } }),
    ).rejects.toThrow("integration.connection_required");
    expect(f.actionPolicy).not.toHaveBeenCalled();
  });

  it("rejects a removed connection", async () => {
    const f = fixture();
    vi.mocked(f.authority.connections).mockResolvedValue([]);
    await expect(
      f.validate({ approval: f.approval, editedArguments: { body: "edited" } }),
    ).rejects.toThrow("integration.connection_required");
  });

  it.each([{ body: 10 }, {}, { body: "text", unexpected: true }])(
    "rejects arguments outside the live schema %j",
    async (editedArguments) => {
      const f = fixture();
      await expect(f.validate({ approval: f.approval, editedArguments })).rejects.toThrow(
        "integration.invalid_arguments",
      );
    },
  );

  it("rejects meta tools without making a metadata call", async () => {
    const f = fixture();
    await expect(
      f.validate({
        approval: { ...f.approval, toolSlug: "COMPOSIO_REMOTE_BASH_TOOL" },
        editedArguments: {},
      }),
    ).rejects.toThrow("integration.tool_unavailable");
    expect(f.authority.schema).not.toHaveBeenCalled();
  });

  it("refuses admission lost during a metadata call", async () => {
    const f = fixture();
    vi.mocked(f.authority.check).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      f.validate({ approval: f.approval, editedArguments: { body: "edited" } }),
    ).rejects.toThrow("integration.unauthorized");
  });

  it("normalizes metadata errors without provider content", async () => {
    const f = fixture();
    vi.mocked(f.authority.schema).mockRejectedValue(new Error("private marker"));
    const error = await f
      .validate({ approval: f.approval, editedArguments: { body: "edited" } })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "integration.provider_failed" });
    expect(error).not.toHaveProperty("cause");
  });

  it("does not silently turn an edited approval into an execution exemption", async () => {
    const f = fixture();
    const validate = createApprovalEditValidator({
      authority: f.authority,
      actionPolicy: () => "exempt",
      policyVersion: "policy",
    });
    expect(
      (await validate({ approval: f.approval, editedArguments: { body: "text" } })).preview.policy,
    ).toBe("exempt");
    // This function only returns a new proposal; it has no execution callback or session.
    const deny = createApprovalEditValidator({
      authority: f.authority,
      actionPolicy: () => "unavailable",
      policyVersion: "policy",
    });
    await expect(deny({ approval: f.approval, editedArguments: { body: "text" } })).rejects.toThrow(
      "integration.tool_unavailable",
    );
  });

  it("masks Vault handle objects in preview without changing stored arguments", async () => {
    const f = fixture();
    f.tool.schema.properties = { body: { type: "object" } };
    const result = await f.validate({
      approval: f.approval,
      editedArguments: { body: { $vault: "grant" } },
    });
    expect(result.arguments.body).toEqual({ $vault: "grant" });
    expect(result.preview.arguments).toEqual({ body: "[Vault value]" });
  });
});
