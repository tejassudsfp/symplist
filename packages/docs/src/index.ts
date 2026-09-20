/**
 * Task documents (§9): Markdown sections, the canonical serializer, the Git versioning service, head
 * snapshots, the publication protocol, changes and diffs, orphan collection and read receipts.
 * Browser code imports only `@symplist/docs/markdown`.
 */

export {
  assertToolCallId,
  BUNDLE_FORMAT_VERSION,
  type BundleRef,
  bundleEnvelopeContext,
  bundleObjectKey,
  bundlePrefix,
  JOB_FORMAT_VERSION,
  type JobRef,
  jobEnvelopeContext,
  jobObjectKey,
  parseBundleObjectKey,
  parseSnapshotObjectKey,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotRef,
  snapshotEnvelopeContext,
  snapshotObjectKey,
  snapshotPrefix,
} from "./artifacts/keys.ts";
export {
  ArtifactIntegrityError,
  DOCUMENT_AUTHOR_KINDS,
  DOCUMENT_COMMIT_KINDS,
  type DocumentAuthorKind,
  type DocumentCommitKind,
  type DocumentSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  markdownDigest,
} from "./artifacts/snapshot.ts";
export {
  CiphertextCache,
  DocumentArtifacts,
  type DocumentArtifactsOptions,
} from "./artifacts/store.ts";
export { DocumentError, type DocumentErrorCode, isDocumentError } from "./errors.ts";
export {
  type DiffHunk,
  type DiffLine,
  type DiffLineKind,
  hunkTouches,
  pageDiffHunks,
  parseUnifiedDiff,
} from "./git/diff.ts";
export {
  findGitExecutable,
  GIT_CONFIG_ENTRIES,
  type GitIdentity,
  gitEnvironment,
} from "./git/environment.ts";
export { GitError, type GitErrorCode, isGitError } from "./git/errors.ts";
export {
  DOCUMENT_PATH,
  DOCUMENT_REF,
  type GitLogEntry,
  GitRepository,
} from "./git/repository.ts";
export { execGit, type GitCommand, type GitCommandRunner } from "./git/runner.ts";
export {
  DEFAULT_GIT_LIMITS,
  GitService,
  type GitServiceLimits,
  type GitServiceOptions,
} from "./git/service.ts";
export { GIT_WORKSPACE_PREFIX, GitTempRoot, type GitWorkspace } from "./git/workspace.ts";
export * as markdown from "./markdown/index.ts";
export {
  authorFromEmail,
  commitMessage,
  commitSubject,
  DOCUMENT_IDENTITIES,
  type HistoryCommit,
  historyCommitFromLog,
  reconstructRepository,
} from "./publication/history.ts";
export {
  DocumentOrphanCollector,
  ORPHAN_COLLECTION_DEFAULTS,
  type OrphanCollectionOptions,
  type OrphanCollectionResult,
} from "./publication/orphans.ts";
export {
  type CurrentDocument,
  contentDigest,
  DEFAULT_PUBLICATION_LIMITS,
  type DocumentEdit,
  DocumentPublisher,
  type DocumentPublisherOptions,
  type EditContext,
  type FoldableOutcome,
  type PublicationContext,
  type PublicationFold,
  type PublicationHooks,
  type PublicationLimits,
  type PublicationOutcome,
  type PublishedDocument,
  type PublishInput,
  type SqlGuard,
} from "./publication/publisher.ts";
export { DocumentHistoryReader } from "./publication/reader.ts";
export {
  COMMIT_COLUMNS,
  type CommitRecord,
  commitFromRow,
  DocumentRowError,
  REPO_COLUMNS,
  type RepoRecord,
  type RequestRecord,
  repoFromRow,
  requestFromRow,
  selectCommitStatement,
  selectRepoStatement,
  selectRequestStatement,
} from "./publication/records.ts";
export {
  computeReadPositions,
  type Reader,
  type ReaderKind,
  type ReceiptDraft,
  type ReceiptRecord,
  type RemovedReadSection,
  receiptFromRow,
  receiptStatement,
  type SectionReadPosition,
  type SectionReadState,
  selectReceiptsStatement,
} from "./receipts/receipts.ts";
export {
  type ConflictSection,
  type ConflictSectionStatus,
  classifyConflict,
  compareSectionIndexes,
  type SectionChange,
  type SectionChangeStatus,
  type SectionPairing,
} from "./sections/changes.ts";
export {
  CursorInvalidError,
  decodeCursor,
  encodeCursor,
  MAX_CURSOR_LENGTH,
} from "./sections/cursor.ts";
export {
  type OutlineEntry,
  outlineEntry,
  outlinePage,
  readSectionChunk,
  type SearchMatch,
  type SectionChunk,
  searchSections,
  searchTerms,
} from "./sections/navigation.ts";
export {
  buildSectionIndex,
  CANONICAL_CHECK_MAX_BYTES,
  findSection,
  type IndexedSection,
  REVISION_PATTERN,
  rebindSectionIndex,
  SECTION_ID_PATTERN,
  type SectionIndex,
  sectionId,
} from "./sections/section-index.ts";
export {
  SectionNotFoundError,
  type SectionPlacement,
  type SpliceInput,
  spliceSection,
} from "./sections/splice.ts";
