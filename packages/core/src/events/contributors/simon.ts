import { SimonExecutionTracker, SimonRunRelaySource } from "../../simon/lifecycle.ts";
import type { EventsContributor } from "./types.ts";

/** Simon's execution seams (§8.1, §8.2): the `simon_run` kind (`simon-run`, payload `{ runId }`, a `runs` tracker) and the `runs` relay source. */
export const simonEventsContributor: EventsContributor = {
  domain: "simon",
  executionKinds: [
    {
      kind: "simon_run",
      triggerTaskId: "simon-run",
      payload: (job) => ({ runId: job.subjectId }),
      sessionTaskId: "simon-chat",
      // A session parks between turns, so it is addressed by the conversation rather than the run:
      // `runs_one_active` keeps at most one live run per conversation, and `simon-chat` resolves it.
      sessionExternalId: (job) => job.sessionExternalId,
      tracker: ({ db, betaAccessRequired }) =>
        new SimonExecutionTracker(db, { betaAccessRequired: betaAccessRequired ?? true }),
    },
  ],
  runRelaySource: ({ db }) => new SimonRunRelaySource(db),
};
