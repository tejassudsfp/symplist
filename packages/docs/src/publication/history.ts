import type { AccountDataKey } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import { bundleObjectKey } from "../artifacts/keys.ts";
import type { DocumentAuthorKind, DocumentCommitKind } from "../artifacts/snapshot.ts";
import { ArtifactIntegrityError } from "../artifacts/snapshot.ts";
import type { DocumentArtifacts } from "../artifacts/store.ts";
import { DocumentError } from "../errors.ts";
import type { GitIdentity } from "../git/environment.ts";
import { GitError } from "../git/errors.ts";
import { DOCUMENT_REF, type GitLogEntry, type GitRepository } from "../git/repository.ts";
import { singleLine } from "../markdown/index.ts";
import type { SectionChange } from "../sections/changes.ts";
import type { RepoRecord } from "./records.ts";

/** Commit identities inside the encrypted history (§9.1): You, Simon, or a connected MCP agent. */
export const DOCUMENT_IDENTITIES: Readonly<
  Record<DocumentAuthorKind, { readonly name: string; readonly email: string }>
> = Object.freeze({
  user: Object.freeze({ name: "You", email: "you@users.symplist.invalid" }),
  simon: Object.freeze({ name: "Simon", email: "simon@agents.symplist.invalid" }),
  mcp: Object.freeze({ name: "MCP agent", email: "mcp@agents.symplist.invalid" }),
});

export function identityFor(author: DocumentAuthorKind, committedAtMs: number): GitIdentity {
  return { ...DOCUMENT_IDENTITIES[author], epochSeconds: Math.floor(committedAtMs / 1000) };
}

export function authorFromEmail(email: string): DocumentAuthorKind | null {
  for (const [kind, identity] of Object.entries(DOCUMENT_IDENTITIES)) {
    if (identity.email === email) return kind as DocumentAuthorKind;
  }
  return null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters never enter commit messages.
const controlCharacters = /[\x00-\x1f\x7f]/g;

function headingLabel(change: SectionChange): string {
  if (change.heading)
    return singleLine(change.heading.replace(controlCharacters, " "), 80) || "Untitled section";
  return change.kind === "preamble" ? "the introduction" : "the page";
}

/**
 * The commit subject shown in history (document_history brief: "Updated Next steps"), derived
 * deterministically from the section changes; no model is involved (note 11).
 */
export function commitSubject(input: {
  readonly kind: DocumentCommitKind;
  readonly changes: readonly SectionChange[];
  readonly restoredFromCommittedAt?: number | null;
}): string {
  if (input.kind === "create") return "Created the page";
  if (input.kind === "normalization") return "Formatting normalized";
  if (input.kind === "restore") {
    const at = input.restoredFromCommittedAt;
    return at
      ? `Restored the version from ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "Restored an earlier version";
  }
  const [first, ...rest] = input.changes;
  if (!first) return "Edited the page";
  const verb =
    first.status === "added" ? "Added" : first.status === "removed" ? "Removed" : "Updated";
  const label = headingLabel(first);
  if (rest.length === 0) return `${verb} ${label}`;
  return `${verb} ${label} and ${rest.length} more ${rest.length === 1 ? "section" : "sections"}`;
}

/** The full commit message: subject, blank line, and Symplist trailers. */
export function commitMessage(input: {
  readonly subject: string;
  readonly author: DocumentAuthorKind;
  readonly kind: DocumentCommitKind;
  readonly restoredFrom: string | null;
}): string {
  const lines = [
    input.subject.replace(controlCharacters, " "),
    "",
    `Symplist-Author: ${input.author}`,
    `Symplist-Kind: ${input.kind}`,
  ];
  if (input.restoredFrom) lines.push(`Symplist-Restored-From: ${input.restoredFrom}`);
  return `${lines.join("\n")}\n`;
}

/** One entry of the history read from Git (§9.2 `task_document_history`). */
export interface HistoryCommit {
  readonly commitId: string;
  readonly parentCommitId: string | null;
  readonly author: DocumentAuthorKind;
  readonly kind: DocumentCommitKind;
  readonly restoredFrom: string | null;
  readonly subject: string;
  /** Commit time in epoch milliseconds. */
  readonly committedAt: number;
}

/** Interprets a Git log entry written by Symplist; anything else is an integrity failure. */
export function historyCommitFromLog(entry: GitLogEntry): HistoryCommit {
  const [subject = "", ...body] = entry.message.split("\n");
  const trailers = new Map<string, string>();
  for (const line of body) {
    const match = /^(Symplist-[A-Za-z-]+): (.+)$/.exec(line);
    if (match) trailers.set(match[1] as string, match[2] as string);
  }
  const author = authorFromEmail(entry.authorEmail);
  const kind = trailers.get("Symplist-Kind");
  const restoredFrom = trailers.get("Symplist-Restored-From") ?? null;
  if (
    !author ||
    trailers.get("Symplist-Author") !== author ||
    !["create", "edit", "normalization", "restore"].includes(kind ?? "") ||
    entry.parents.length > 1 ||
    (restoredFrom !== null && !/^[0-9a-f]{40}$/.test(restoredFrom))
  ) {
    throw new DocumentError("document.integrity_failed");
  }
  return Object.freeze({
    commitId: entry.commitId,
    parentCommitId: entry.parents[0] ?? null,
    author,
    kind: kind as DocumentCommitKind,
    restoredFrom,
    subject,
    committedAt: entry.authoredAt * 1000,
  });
}

/**
 * Reconstructs the published repository of a head row into a private bare repository (§9.1, note 11
 * step 3): download and decrypt the bundle named by D1, verify it is self-contained and carries exactly
 * `refs/heads/main` at the published head, unbundle, set the ref, `fsck --strict`, and check the commit
 * count against D1. Returns the head document. Any failure is `document.integrity_failed` without
 * plaintext in the error.
 */
export async function reconstructRepository(input: {
  readonly repository: GitRepository;
  readonly artifacts: DocumentArtifacts;
  readonly accountKey: AccountDataKey;
  readonly repo: RepoRecord;
}): Promise<string> {
  const { repository, artifacts, accountKey, repo } = input;
  const ref = {
    ownerId: repo.ownerId,
    taskId: repo.taskId,
    generation: repo.generation,
    writeId: repo.bundleWriteId,
  };
  let bundle: Buffer | undefined;
  try {
    if (bundleObjectKey(ref) !== repo.bundleKey) throw new ArtifactIntegrityError("mismatch");
    bundle = await artifacts.getBundle(accountKey, ref);
    const refs = await repository.unbundle("head.bundle", bundle);
    if (refs.size !== 1 || refs.get(DOCUMENT_REF) !== repo.headCommitId) {
      throw new ArtifactIntegrityError("mismatch");
    }
    await repository.updateMain(repo.headCommitId, null);
    await repository.fsck();
    if ((await repository.commitCount(repo.headCommitId)) !== repo.commitCount) {
      throw new ArtifactIntegrityError("mismatch");
    }
    const document = await repository.readDocument(repo.headCommitId);
    try {
      return document.toString("utf8");
    } finally {
      zeroize(document);
    }
  } catch (error) {
    if (
      error instanceof GitError &&
      ["git.busy", "git.unavailable", "git.timeout"].includes(error.code)
    ) {
      throw error;
    }
    if (error instanceof GitError || error instanceof ArtifactIntegrityError) {
      throw new DocumentError("document.integrity_failed");
    }
    throw error;
  } finally {
    if (bundle) zeroize(bundle);
  }
}
