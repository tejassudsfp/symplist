import {
  type DocumentCompareResponse,
  type DocumentConflictResponse,
  type DocumentHeadResponse,
  type DocumentHistoryResponse,
  type DocumentPublishResponse,
  type DocumentRevisionResponse,
  documentCompareResponseSchema,
  documentConflictResponseSchema,
  documentDraftPutResponseSchema,
  documentHeadResponseSchema,
  documentHistoryResponseSchema,
  documentPublishResponseSchema,
  documentRevisionResponseSchema,
} from "@symplist/contracts";
import type { z } from "zod";
import { type ApiClient, ApiClientError, ApiConfigurationError, getApiClient } from "@/lib/api";

/**
 * The browser side of the task page API (§9.2, §9.3). Every response is validated against its
 * contracts schema, so a body the client does not understand fails loudly instead of rendering as a
 * half-loaded page. The interface is the seam component tests replace with a fake.
 */

export type DocumentDraftPutResponse = z.infer<typeof documentDraftPutResponseSchema>;

export interface DocumentSaveInput {
  readonly baseRevision: string | null;
  readonly markdown: string;
  readonly kind: "edit" | "normalization";
  /** The draft sequence this save covers; the stored draft is cleared when it is not newer. */
  readonly draftSeq?: number;
  /** Reused on every retry of the same intent, so an exact retry replays its outcome (§6.1). */
  readonly idempotencyKey: string;
}

export interface DocumentRestoreInput {
  readonly revision: string;
  /** The head the user previewed against; a newer head is a restore conflict. */
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
}

export interface DocumentPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface DocumentCompareQuery {
  readonly base: string;
  readonly target?: string;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface DocumentApi {
  head(taskId: string, signal?: AbortSignal): Promise<DocumentHeadResponse>;
  publish(taskId: string, input: DocumentSaveInput): Promise<DocumentPublishResponse>;
  putDraft(
    taskId: string,
    input: {
      readonly baseRevision: string | null;
      readonly clientSeq: number;
      readonly markdown: string;
    },
  ): Promise<DocumentDraftPutResponse>;
  deleteDraft(taskId: string, clientSeq: number): Promise<void>;
  history(taskId: string, query?: DocumentPageQuery): Promise<DocumentHistoryResponse>;
  revision(
    taskId: string,
    revision: string,
    signal?: AbortSignal,
  ): Promise<DocumentRevisionResponse>;
  compare(taskId: string, query: DocumentCompareQuery): Promise<DocumentCompareResponse>;
  restore(taskId: string, input: DocumentRestoreInput): Promise<DocumentPublishResponse>;
  conflict(
    taskId: string,
    base: string | null,
    signal?: AbortSignal,
  ): Promise<DocumentConflictResponse>;
}

/** `/v1/tasks/:taskId/document…`, with the task id escaped even though routes only ever pass UUIDs. */
export function documentPath(taskId: string, suffix = ""): string {
  return `/v1/tasks/${encodeURIComponent(taskId)}/document${suffix}`;
}

/** The documents API bound to an `ApiClient`; `createDocumentApi()` uses the app-wide client. */
export function createDocumentApi(client: ApiClient): DocumentApi {
  return {
    head: (taskId, signal) =>
      client.get(documentPath(taskId), {
        schema: documentHeadResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    publish: (taskId, input) =>
      client.post(documentPath(taskId, "/commits"), {
        schema: documentPublishResponseSchema,
        idempotencyKey: input.idempotencyKey,
        body: {
          baseRevision: input.baseRevision,
          markdown: input.markdown,
          kind: input.kind,
          ...(input.draftSeq === undefined ? {} : { draftSeq: input.draftSeq }),
        },
      }),
    putDraft: (taskId, input) =>
      client.put(documentPath(taskId, "/draft"), {
        schema: documentDraftPutResponseSchema,
        body: input,
      }),
    deleteDraft: async (taskId, clientSeq) => {
      await client.delete(documentPath(taskId, "/draft"), { query: { clientSeq } });
    },
    history: (taskId, query = {}) =>
      client.get(documentPath(taskId, "/history"), {
        schema: documentHistoryResponseSchema,
        query: {
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        },
        ...(query.signal ? { signal: query.signal } : {}),
      }),
    revision: (taskId, revision, signal) =>
      client.get(documentPath(taskId, `/revisions/${encodeURIComponent(revision)}`), {
        schema: documentRevisionResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    compare: (taskId, query) =>
      client.get(documentPath(taskId, "/compare"), {
        schema: documentCompareResponseSchema,
        query: {
          base: query.base,
          ...(query.target === undefined ? {} : { target: query.target }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        },
        ...(query.signal ? { signal: query.signal } : {}),
      }),
    restore: (taskId, input) =>
      client.post(documentPath(taskId, "/restore"), {
        schema: documentPublishResponseSchema,
        idempotencyKey: input.idempotencyKey,
        body: { revision: input.revision, expectedRevision: input.expectedRevision },
      }),
    conflict: (taskId, base, signal) =>
      client.get(documentPath(taskId, "/conflict"), {
        schema: documentConflictResponseSchema,
        query: { base: base ?? "none" },
        ...(signal ? { signal } : {}),
      }),
  };
}

let shared: DocumentApi | null = null;

/**
 * An API that answers every call with the reason it cannot be reached. It is used when the build has
 * no API origin, or when the page is rendered outside a browser, so the task page shows a plain
 * "this isn't available here" state instead of throwing inside the shell (system_states.md).
 */
export function unavailableDocumentApi(error: ApiClientError): DocumentApi {
  const fail = async (): Promise<never> => {
    throw error;
  };
  return {
    head: fail,
    publish: fail,
    putDraft: fail,
    deleteDraft: fail,
    history: fail,
    revision: fail,
    compare: fail,
    restore: fail,
    conflict: fail,
  };
}

/** The documents API on the app-wide client, or one that reports why it is unavailable. */
export function documentApi(): DocumentApi {
  if (!shared) {
    try {
      shared = createDocumentApi(getApiClient());
    } catch (error) {
      return unavailableDocumentApi(
        error instanceof ApiClientError
          ? error
          : new ApiConfigurationError("The Symplist API origin is not configured"),
      );
    }
  }
  return shared;
}
