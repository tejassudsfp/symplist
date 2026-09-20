import { DurableDocumentGit } from "@symplist/core/documents";
import { SharingRepository } from "@symplist/core/sharing";
import { SimonRepository } from "@symplist/core/simon";
import { createScriptedModel, scriptedText, scriptedToolCall } from "@symplist/testing";
import { describe, expect, it, vi } from "vitest";
import { createDocumentsTestEnvironment } from "../../core/src/documents/test-support.ts";
import { int, sql, uuidv7 } from "../../db/src/index.ts";
import { simonSharingTools } from "./sharing.ts";
import { runSimonTurn } from "./turn.ts";

describe.each(["local", "trigger"] as const)("Sharing model-loop parity under %s", (executor) => {
  it.each([false, true])(
    "registers the correct tool surface and checkpoints real effects (quick=%s)",
    async (quick) => {
      const env = await createDocumentsTestEnvironment();
      try {
        const owner = await env.createUser();
        const taskId = await env.createTask(owner);
        const foreignTask = await env.createTask(await env.createUser());
        const revision = String(
          (
            await env.tools.updateSection(env.simon(owner, taskId), {
              taskId,
              expectedRevision: null,
              placement: "end",
              markdown: "# Context\nDOCUMENT-PRIVATE-MARKER",
            })
          ).revision,
        );
        const sharing = new SharingRepository({
          db: env.db,
          objects: env.objects,
          keys: env.keys,
          now: () => env.clock,
          policy: { betaAccessRequired: true },
          artifactOrigin: "https://share.example.test",
        });
        const artifact = await sharing.snapshot(
          env.user(owner),
          taskId,
          { title: "Private artifact", revision, sectionIds: [] },
          "seed",
        );
        const grantId = uuidv7();
        const publication = uuidv7();
        await env.db.run(
          sql(
            `INSERT INTO share_grants (id,owner_id,artifact_id,mode,publication_id,created_at,write_id)
        VALUES (:id,:owner,:artifact,'public',:publication,:now,:write)`,
            {
              id: grantId,
              owner,
              artifact: artifact.id,
              publication,
              now: int(env.clock),
              write: uuidv7(),
            },
          ),
        );
        await env.db.run(
          sql("UPDATE executor_state SET mode=:mode", {
            mode: executor === "trigger" ? "durable" : "local",
          }),
        );
        const repository = new SimonRepository({
          db: env.db,
          keys: env.keys,
          now: () => env.clock,
          policy: { betaAccessRequired: true },
          quickChatTtlHours: 24,
        });
        const conversation = await repository.createConversation(owner, quick ? null : taskId);
        const accepted = await repository.acceptMessage(owner, conversation, "sharing-loop", {
          text: "Prepare a private handoff for this task",
          tier: "fast",
        });
        const script = createScriptedModel([
          scriptedToolCall("artifact_share_list", { taskId }),
          scriptedToolCall("artifact_share_list", { taskId: foreignTask }),
          ...(quick
            ? []
            : [
                scriptedToolCall("artifact_snapshot", { taskId, revision, title: "New snapshot" }),
                scriptedToolCall("artifact_share_create", {
                  artifactId: artifact.id,
                  expectedHead: revision,
                  mode: "link",
                  expiresAt: env.clock + 86_400_000,
                }),
                scriptedToolCall("artifact_share_revoke", { artifactId: artifact.id, grantId }),
                scriptedToolCall("handoff_prepare", {
                  taskId,
                  revision,
                  title: "Draft",
                  target: "coding_assistant",
                  prompt: "Implement the objective; return the patch for review.",
                  artifactIds: [artifact.id],
                }),
              ]),
          scriptedText("Private references are ready for review. No link was released."),
        ]);
        const gitCall = vi.fn(async () => {
          throw new Error("Sharing cannot run Git");
        });
        const changed = vi.fn(async () => {});
        const confirmed = vi.fn(async () => {});
        let names: string[] = [];
        const result = await runSimonTurn(String(accepted.runId), {
          repository,
          executor,
          models: {
            resolve: () => ({
              provider: "scripted",
              modelId: script.model.modelId,
              model: script.model,
            }),
          },
          signal: new AbortController().signal,
          telemetryEnabled: false,
          log: vi.fn(),
          documents: () => ({
            tools: env.tools,
            git:
              executor === "local"
                ? null
                : new DurableDocumentGit({
                    artifacts: env.repository.artifacts,
                    now: () => env.clock,
                    triggerAndWait: gitCall,
                  }),
          }),
          tools: async (context) => {
            const tools = simonSharingTools(context, {
              objects: env.objects,
              onGrantChanged: changed,
              onConfirmed: confirmed,
            });
            names = Object.keys(tools);
            return tools;
          },
          sink: () => ({ write: vi.fn(), flush: async () => {}, close: async () => {} }),
        });
        expect(result).toEqual({ status: "completed", steps: quick ? 3 : 7 });
        expect(script.remaining()).toBe(0);
        expect(names.sort()).toEqual(
          (quick
            ? ["artifact_share_list"]
            : [
                "artifact_snapshot",
                "artifact_share_create",
                "artifact_share_list",
                "artifact_share_revoke",
                "handoff_prepare",
              ]
          ).sort(),
        );
        const lastPrompt = JSON.stringify(script.calls.at(-1)?.prompt);
        expect(lastPrompt).toContain("not_found");
        expect(lastPrompt).not.toContain(publication);
        expect(lastPrompt).not.toContain("https://share.example.test");
        expect(lastPrompt).not.toContain("DOCUMENT-PRIVATE-MARKER");
        expect(await env.count("artifacts")).toBe(quick ? 1 : 3);
        expect(await env.count("share_grants")).toBe(1);
        expect(await env.count("share_approvals")).toBe(quick ? 0 : 1);
        expect(
          await env.db.first(sql("SELECT status FROM share_grants WHERE id=:id", { id: grantId })),
        ).toEqual({ status: quick ? "active" : "revoked" });
        expect(changed).toHaveBeenCalledTimes(quick ? 0 : 1);
        expect(confirmed).toHaveBeenCalledTimes(quick ? 0 : 1);
        if (!quick)
          expect(confirmed).toHaveBeenCalledWith(
            owner,
            "handoff_prepared",
            { target: "coding_assistant", sections: "whole_document", author: "simon" },
            expect.any(String),
          );
        expect(gitCall).not.toHaveBeenCalled();
        const parts = await env.db.all(sql("SELECT content_enc FROM message_parts"));
        expect(parts.length).toBeGreaterThan(0);
        expect(parts.every((row) => String(row.content_enc).startsWith("sym1."))).toBe(true);
      } finally {
        await env.close();
      }
    },
  );
});
