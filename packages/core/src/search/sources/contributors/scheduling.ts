import type { SearchSourceContributor } from "../types.ts";

/**
 * The scheduling search source (§12.1, note 14 deadline filters). It adds `deadlines`: a
 * `DeadlineFilterSource` over `task_schedules`. Until it does, requests with a deadline filter answer
 * `search.filter_unavailable`.
 */
export const schedulingSearchSourceContributor: SearchSourceContributor = {
  domain: "scheduling",
};
