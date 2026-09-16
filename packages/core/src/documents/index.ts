/** Document publication, head reads, drafts, tools and read receipts through `@symplist/docs` (§9). */
export {
  actorGuards,
  agentRequest,
  authorizeActor,
  authorOf,
  contextEpochOf,
  type DocumentActor,
  type McpDocumentActor,
  readerOf,
  type SimonDocumentActor,
  type UserDocumentActor,
} from "./actor.ts";
export {
  clampToBudget,
  DOCUMENT_GRANT_RETRIEVAL_BYTES,
  DOCUMENT_GRANT_RETRIEVAL_WINDOW_MS,
  DOCUMENT_TURN_RETRIEVAL_BYTES,
  GrantRetrievalBudgets,
  type RetrievalBudget,
  TurnRetrievalBudget,
} from "./budgets.ts";
export { DocumentAccessContext, DocumentAccessDeniedError } from "./context.ts";
export {
  deleteDraftStatement,
  draftEnvelopeContext,
  draftFromRow,
  type StoredDraft,
  selectDraftStatement,
  upsertDraftStatement,
} from "./drafts.ts";
export {
  DOCUMENT_HEAD_CHANGED_EVENT,
  type DocumentEventSink,
  type DocumentHeadChanged,
  headChangedPayload,
} from "./events.ts";
export {
  DOCUMENT_GIT_TASK_ID,
  type DocumentGitJobActor,
  type DocumentGitJobInput,
  type DocumentGitJobOutput,
  type DocumentGitOperation,
  DurableDocumentGit,
  executeDocumentGitOperation,
  executorGenerationGuard,
  runDocumentGitJob,
  type TriggerAndWait,
} from "./git-jobs.ts";
export {
  DocumentMaintenance,
  type DocumentMaintenanceResult,
  READ_RECEIPT_RETENTION_MS,
} from "./maintenance.ts";
export {
  DocumentRepository,
  type DocumentRepositoryOptions,
  type LoadedDocument,
} from "./repository.ts";
export {
  DEFAULT_DOCUMENT_SERVICE_LIMITS,
  DocumentService,
  type DocumentServiceLimits,
  type FoldedResult,
  type HeadDocument,
  historyPage,
  publishRestore,
} from "./service.ts";
export { type AgentDocumentActor, DOCUMENT_TOOL_LIMITS, DocumentTools } from "./tools.ts";
export {
  type HistoryItem,
  type PublishResult,
  publishResult,
  type SectionSummary,
  sectionSummary,
} from "./views.ts";
