import type { SearchSourceContributor } from "../types.ts";

/**
 * The documents feature's search source (§9.2, §10.1). It adds `documents`: a `DocumentTextSource`
 * reading current heads from `doc_repos` and the immutable encrypted head snapshots, returning plain
 * text sections. Until it does, no task has a document, so search indexes titles only.
 */
export const documentsSearchSourceContributor: SearchSourceContributor = {
  domain: "documents",
};
