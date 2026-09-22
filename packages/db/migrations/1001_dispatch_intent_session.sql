-- The durable chat session an intent's work joins (note 07 "Execution contract", §8.1). A session
-- spans several runs of one conversation, so it is addressed by an identity that outlives a single
-- subject: for `simon_run` the subject is one run and this column holds its conversation. It is
-- written in the batch that accepts the work, where the intent's INSERT already reads the `runs`
-- row, so dispatch knows which session to start without a second D1 read on the api lane.
ALTER TABLE dispatch_intents ADD COLUMN session_external_id TEXT;
