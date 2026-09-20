import type { ObjectEnvelopeContext } from "@symplist/crypto";

/**
 * R2 object keys and envelope bindings for document artifacts (§4.1, §4.2). Keys are owner-prefixed
 * and opaque (ids, generations and write ids only), and the object AAD binds owner, artifact kind,
 * task and artifact identity, and format version, so an object copied to another task, owner or
 * generation fails to decrypt.
 */

export const BUNDLE_FORMAT_VERSION = 1;
export const SNAPSHOT_FORMAT_VERSION = 1;
export const JOB_FORMAT_VERSION = 1;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const toolCallPattern = /^[A-Za-z0-9_-]{1,128}$/;

function uuid(value: string, what: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new TypeError(`Invalid ${what}`);
  return value;
}

function revision(value: string): string {
  if (typeof value !== "string" || !revisionPattern.test(value))
    throw new TypeError("Invalid revision");
  return value;
}

function generationOf(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid generation");
  return value;
}

/** A tool call id usable inside object keys: 1 to 128 URL-safe characters. */
export function assertToolCallId(value: string): string {
  if (typeof value !== "string" || !toolCallPattern.test(value)) {
    throw new TypeError("Invalid tool call id");
  }
  return value;
}

/** `u/<ownerId>/bundles/<taskId>/` */
export function bundlePrefix(ownerId: string, taskId: string): string {
  return `u/${uuid(ownerId, "owner")}/bundles/${uuid(taskId, "task")}/`;
}

/** `u/<ownerId>/docs/<taskId>/` */
export function snapshotPrefix(ownerId: string, taskId: string): string {
  return `u/${uuid(ownerId, "owner")}/docs/${uuid(taskId, "task")}/`;
}

export interface BundleRef {
  readonly ownerId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly writeId: string;
}

/** `u/<ownerId>/bundles/<taskId>/<generation>-<writeId>.bundle.sym` (§4.1). */
export function bundleObjectKey(ref: BundleRef): string {
  return `${bundlePrefix(ref.ownerId, ref.taskId)}${generationOf(ref.generation)}-${uuid(ref.writeId, "write id")}.bundle.sym`;
}

export function bundleEnvelopeContext(ref: BundleRef): ObjectEnvelopeContext {
  return Object.freeze({
    kind: "doc_bundle",
    ownerId: uuid(ref.ownerId, "owner"),
    objectId: `bundles/${uuid(ref.taskId, "task")}/${generationOf(ref.generation)}-${uuid(ref.writeId, "write id")}`,
    formatVersion: BUNDLE_FORMAT_VERSION,
  });
}

/** Parses a bundle key back into its reference; null for any other key. */
export function parseBundleObjectKey(key: string): BundleRef | null {
  const match =
    /^u\/([0-9a-f-]{36})\/bundles\/([0-9a-f-]{36})\/([1-9][0-9]{0,15})-([0-9a-f-]{36})\.bundle\.sym$/.exec(
      key,
    );
  if (!match) return null;
  const [, ownerId, taskId, generation, writeId] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!uuidPattern.test(ownerId) || !uuidPattern.test(taskId) || !uuidPattern.test(writeId))
    return null;
  const parsed = Number(generation);
  return Number.isSafeInteger(parsed) ? { ownerId, taskId, generation: parsed, writeId } : null;
}

export interface SnapshotRef {
  readonly ownerId: string;
  readonly taskId: string;
  readonly commitId: string;
}

/** `u/<ownerId>/docs/<taskId>/<commitId>.md.sym` (§4.1, §9.2). */
export function snapshotObjectKey(ref: SnapshotRef): string {
  return `${snapshotPrefix(ref.ownerId, ref.taskId)}${revision(ref.commitId)}.md.sym`;
}

export function snapshotEnvelopeContext(ref: SnapshotRef): ObjectEnvelopeContext {
  return Object.freeze({
    kind: "doc_snapshot",
    ownerId: uuid(ref.ownerId, "owner"),
    objectId: `docs/${uuid(ref.taskId, "task")}/${revision(ref.commitId)}`,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
  });
}

/** Parses a snapshot key back into its reference; null for any other key. */
export function parseSnapshotObjectKey(key: string): SnapshotRef | null {
  const match = /^u\/([0-9a-f-]{36})\/docs\/([0-9a-f-]{36})\/([0-9a-f]{40})\.md\.sym$/.exec(key);
  if (!match) return null;
  const [, ownerId, taskId, commitId] = match as unknown as [string, string, string, string];
  if (!uuidPattern.test(ownerId) || !uuidPattern.test(taskId)) return null;
  return { ownerId, taskId, commitId };
}

export interface JobRef {
  readonly ownerId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly direction: "in" | "out";
}

/** `u/<ownerId>/jobs/<runId>/<toolCallId>.<in|out>.sym` (§8.3). */
export function jobObjectKey(ref: JobRef): string {
  return `u/${uuid(ref.ownerId, "owner")}/jobs/${uuid(ref.runId, "run")}/${assertToolCallId(ref.toolCallId)}.${ref.direction === "in" ? "in" : "out"}.sym`;
}

export function jobEnvelopeContext(ref: JobRef): ObjectEnvelopeContext {
  return Object.freeze({
    kind: "doc_job",
    ownerId: uuid(ref.ownerId, "owner"),
    objectId: `jobs/${uuid(ref.runId, "run")}/${assertToolCallId(ref.toolCallId)}.${ref.direction === "in" ? "in" : "out"}`,
    formatVersion: JOB_FORMAT_VERSION,
  });
}
