import { describe, expect, it } from "vitest";
import {
  decodeWsServerFrame,
  documentGitPayloadSchema,
  documentHeadResponseSchema,
  documentSaveRequestSchema,
  documentsTools,
  errorHttpStatus,
  taskDocumentReadSectionInputSchema,
  taskDocumentUpdateSectionInputSchema,
  toolContracts,
} from "../index.ts";

const taskId = "0192f0a0-0000-7000-8000-000000000101";
const revision = "0123456789abcdef0123456789abcdef01234567";

describe("documents contracts", () => {
  it("declares the error codes with their statuses", () => {
    expect(errorHttpStatus("document.conflict")).toBe(409);
    expect(errorHttpStatus("document.resync_required")).toBe(409);
    expect(errorHttpStatus("document.too_large")).toBe(413);
    expect(errorHttpStatus("document.integrity_failed")).toBe(500);
  });

  it("decodes document.head_changed only on the user topic with ids and no text", () => {
    const frame = {
      t: "ev",
      topic: "user",
      seq: 1,
      id: "0192f0a0-0000-7000-8000-000000000999",
      type: "document.head_changed",
      data: {
        taskId,
        revision,
        author: "simon",
        changedSectionIds: ["s0123456789abcdefghijklmno"],
      },
    };
    expect(decodeWsServerFrame(JSON.stringify(frame))).toEqual(frame);
    expect(
      decodeWsServerFrame(JSON.stringify({ ...frame, data: { ...frame.data, markdown: "leak" } })),
    ).toBeNull();
    expect(
      decodeWsServerFrame(
        JSON.stringify({ ...frame, topic: "conversation:0192f0a0-0000-7000-8000-000000000501" }),
      ),
    ).toBeNull();
  });

  it("registers all eight document tools with strict inputs", () => {
    expect(Object.keys(documentsTools).sort()).toEqual([
      "task_document_changes",
      "task_document_diff",
      "task_document_history",
      "task_document_outline",
      "task_document_read_section",
      "task_document_restore",
      "task_document_search",
      "task_document_update_section",
    ]);
    for (const name of Object.keys(documentsTools)) expect(toolContracts).toHaveProperty(name);
    expect(
      taskDocumentReadSectionInputSchema.safeParse({
        taskId,
        sectionId: "s0123456789abcdefghijklmno",
        revision,
        maxBytes: 999_999,
      }).success,
    ).toBe(false);
    expect(
      taskDocumentReadSectionInputSchema.safeParse({ taskId, sectionId: "Next steps", revision })
        .success,
    ).toBe(false);
    expect(
      taskDocumentUpdateSectionInputSchema.parse({
        taskId,
        expectedRevision: null,
        markdown: "# A",
      }),
    ).toMatchObject({
      placement: "replace",
    });
    expect(
      taskDocumentUpdateSectionInputSchema.safeParse({
        taskId,
        expectedRevision: "HEAD",
        markdown: "# A",
      }).success,
    ).toBe(false);
  });

  it("keeps the document-git payload ids-only", () => {
    const payload = {
      runId: "0192f0a0-0000-7000-8000-000000000601",
      toolCallId: "call_abc123",
      taskId,
      op: "restore",
    };
    expect(documentGitPayloadSchema.parse(payload)).toEqual(payload);
    expect(documentGitPayloadSchema.safeParse({ ...payload, markdown: "x" }).success).toBe(false);
    expect(
      documentGitPayloadSchema.safeParse({ ...payload, toolCallId: "call with spaces" }).success,
    ).toBe(false);
  });

  it("validates save requests and head responses", () => {
    expect(documentSaveRequestSchema.parse({ baseRevision: null, markdown: "" })).toEqual({
      baseRevision: null,
      markdown: "",
      kind: "edit",
    });
    expect(
      documentSaveRequestSchema.safeParse({
        baseRevision: revision,
        markdown: "x",
        kind: "restore",
      }).success,
    ).toBe(false);
    expect(
      documentHeadResponseSchema.safeParse({
        taskId,
        revision: null,
        generation: 0,
        author: null,
        updatedAt: null,
        markdown: "",
        bytes: 0,
        canonical: true,
        hasRawHtml: false,
        parseMode: "parsed",
        sections: [],
        draft: null,
      }).success,
    ).toBe(true);
  });
});
