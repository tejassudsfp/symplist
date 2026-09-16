import type { ArchiveContributor } from "./types.ts";

/**
 * Search task-archive statements (§2.1, §10.1): none. The tasks domain owns `tasks` and the deciding
 * archive statement, and records the `search_intents` upserts itself, in the same batch, from
 * `plans.ts` — for every task the completion archived *and* every subtask `parent_only` promoted
 * into its place, each guarded by `tasks.write_id = <the archive write>` so the index learns of the
 * archive exactly when it committed. A second insert from here would write every archived task's
 * intent twice (the rows carry no unique key), and the seam forbids a contributor from writing
 * `tasks` at all, so it could not narrow that to the rows the plan missed.
 *
 * The contributor stays registered so search keeps its place in the seam's batch order for anything
 * an archive must do to the index beyond an intent — dropping a cached view, say.
 *
 * @see `searchIntentStatements` in `../plans.ts`
 */
export const searchArchiveContributor: ArchiveContributor = {
  domain: "search",
  statements: () => [],
};
