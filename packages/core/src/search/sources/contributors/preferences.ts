import type { SearchSourceContributor } from "../types.ts";

/**
 * The preferences search source (§10.3). It adds `chatOptIn`: a `ChatOptInSource` reading the owner's
 * `privacy` preference group. Until it does, chat content is never included in search, which is the
 * opt-in default of §10.1.
 */
export const preferencesSearchSourceContributor: SearchSourceContributor = {
  domain: "preferences",
};
