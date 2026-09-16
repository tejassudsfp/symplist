import { describe, expect, it } from "vitest";
import { type ApiClient, ApiConfigurationError, type RequestOptions } from "@/lib/api";
import { createDocumentApi, documentPath, unavailableDocumentApi } from "./api.ts";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly options: RequestOptions<unknown>;
}

/** An `ApiClient` that records what the documents API asked for and answers with `reply`. */
function recordingClient(reply: unknown = {}): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (path: string, options: RequestOptions<unknown> = {}): Promise<unknown> => {
      calls.push({ method, path, options });
      return reply;
    };
  const client = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  } as unknown as ApiClient;
  return { client, calls };
}

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
const revision = "a".repeat(40);

describe("documentPath", () => {
  it("is the task's document route, with a suffix when one is given", () => {
    expect(documentPath(taskId)).toBe(`/v1/tasks/${taskId}/document`);
    expect(documentPath(taskId, "/commits")).toBe(`/v1/tasks/${taskId}/document/commits`);
  });

  it("escapes the task id even though routes only ever pass ids", () => {
    expect(documentPath("../admin")).toBe("/v1/tasks/..%2Fadmin/document");
  });
});

describe("createDocumentApi", () => {
  it("reads the head, passing an abort signal only when given one", async () => {
    const { client, calls } = recordingClient();
    const api = createDocumentApi(client);
    const signal = new AbortController().signal;
    await api.head(taskId, signal);
    await api.head(taskId);
    expect(calls[0]).toMatchObject({ method: "GET", path: `/v1/tasks/${taskId}/document` });
    expect(calls[0]?.options.signal).toBe(signal);
    expect(calls[0]?.options.schema).toBeDefined();
    expect("signal" in (calls[1]?.options ?? {})).toBe(false);
  });

  it("publishes with the caller's idempotency key so an exact retry replays its outcome", async () => {
    const { client, calls } = recordingClient();
    await createDocumentApi(client).publish(taskId, {
      baseRevision: revision,
      markdown: "# Hello\n",
      kind: "edit",
      draftSeq: 7,
      idempotencyKey: "key-1",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/v1/tasks/${taskId}/document/commits`,
    });
    expect(calls[0]?.options.idempotencyKey).toBe("key-1");
    expect(calls[0]?.options.body).toEqual({
      baseRevision: revision,
      markdown: "# Hello\n",
      kind: "edit",
      draftSeq: 7,
    });
  });

  it("omits the draft sequence when the page has written no draft", async () => {
    const { client, calls } = recordingClient();
    await createDocumentApi(client).publish(taskId, {
      baseRevision: null,
      markdown: "x",
      kind: "normalization",
      idempotencyKey: "key-2",
    });
    expect(calls[0]?.options.body).toEqual({
      baseRevision: null,
      markdown: "x",
      kind: "normalization",
    });
  });

  it("writes and deletes drafts by client sequence", async () => {
    const { client, calls } = recordingClient({ clientSeq: 3, updatedAt: 1 });
    const api = createDocumentApi(client);
    await api.putDraft(taskId, { baseRevision: revision, clientSeq: 3, markdown: "draft" });
    await api.deleteDraft(taskId, 4);
    expect(calls[0]).toMatchObject({ method: "PUT", path: `/v1/tasks/${taskId}/document/draft` });
    expect(calls[0]?.options.body).toEqual({
      baseRevision: revision,
      clientSeq: 3,
      markdown: "draft",
    });
    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1]?.options.query).toEqual({ clientSeq: 4 });
  });

  it("pages history and sends only the parameters it was given", async () => {
    const { client, calls } = recordingClient();
    const api = createDocumentApi(client);
    await api.history(taskId, { limit: 25, cursor: "c1" });
    await api.history(taskId);
    expect(calls[0]?.options.query).toEqual({ limit: 25, cursor: "c1" });
    expect(calls[1]?.options.query).toEqual({});
  });

  it("escapes a revision in the revision path", async () => {
    const { client, calls } = recordingClient();
    await createDocumentApi(client).revision(taskId, "../../secret");
    expect(calls[0]?.path).toBe(`/v1/tasks/${taskId}/document/revisions/..%2F..%2Fsecret`);
  });

  it("compares with a base and an optional target and cursor", async () => {
    const { client, calls } = recordingClient();
    const api = createDocumentApi(client);
    await api.compare(taskId, { base: revision, target: "b".repeat(40), cursor: "c2" });
    await api.compare(taskId, { base: revision });
    expect(calls[0]?.options.query).toEqual({
      base: revision,
      target: "b".repeat(40),
      cursor: "c2",
    });
    expect(calls[1]?.options.query).toEqual({ base: revision });
  });

  it("restores against the revision the user previewed", async () => {
    const { client, calls } = recordingClient();
    await createDocumentApi(client).restore(taskId, {
      revision,
      expectedRevision: "b".repeat(40),
      idempotencyKey: "key-3",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/v1/tasks/${taskId}/document/restore`,
    });
    expect(calls[0]?.options.idempotencyKey).toBe("key-3");
    expect(calls[0]?.options.body).toEqual({ revision, expectedRevision: "b".repeat(40) });
  });

  it("asks for conflict review against a base, sending `none` when there is no revision", async () => {
    const { client, calls } = recordingClient();
    const api = createDocumentApi(client);
    await api.conflict(taskId, revision);
    await api.conflict(taskId, null);
    expect(calls[0]?.options.query).toEqual({ base: revision });
    expect(calls[1]?.options.query).toEqual({ base: "none" });
  });

  it("validates every response against its contracts schema", async () => {
    const { client, calls } = recordingClient();
    const api = createDocumentApi(client);
    await api.head(taskId);
    await api.history(taskId);
    await api.revision(taskId, revision);
    await api.compare(taskId, { base: revision });
    await api.restore(taskId, { revision, expectedRevision: revision, idempotencyKey: "k" });
    await api.conflict(taskId, null);
    for (const call of calls) expect(call.options.schema).toBeDefined();
  });
});

describe("unavailableDocumentApi", () => {
  it("answers every call with the reason it cannot be reached", async () => {
    const reason = new ApiConfigurationError("The Symplist API origin is not configured");
    const api = unavailableDocumentApi(reason);
    const calls = [
      api.head(taskId),
      api.publish(taskId, { baseRevision: null, markdown: "", kind: "edit", idempotencyKey: "k" }),
      api.putDraft(taskId, { baseRevision: null, clientSeq: 1, markdown: "" }),
      api.deleteDraft(taskId, 1),
      api.history(taskId),
      api.revision(taskId, revision),
      api.compare(taskId, { base: revision }),
      api.restore(taskId, { revision, expectedRevision: revision, idempotencyKey: "k" }),
      api.conflict(taskId, null),
    ];
    for (const call of calls) await expect(call).rejects.toBe(reason);
  });
});
