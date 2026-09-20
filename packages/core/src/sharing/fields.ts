import type { SharingArtifact, SharingGrant } from "@symplist/contracts";
import type { AccountDataKey, FieldEnvelopeContext } from "@symplist/crypto";
import { decryptFieldText, encryptFieldText } from "@symplist/crypto";
import type { DbRow } from "@symplist/db";

export function sharingField(
  ownerId: string,
  table: string,
  rowId: string,
  column: string,
): FieldEnvelopeContext {
  return { purpose: "sharing", ownerId, table, rowId, column };
}
export function sharingEncrypt(
  key: AccountDataKey,
  table: string,
  id: string,
  column: string,
  value: string,
): string {
  return encryptFieldText(key, sharingField(key.ownerId, table, id, column), value);
}
export function sharingDecrypt(
  key: AccountDataKey,
  table: string,
  id: string,
  column: string,
  value: string,
): string {
  return decryptFieldText(key, sharingField(key.ownerId, table, id, column), value);
}
export function artifactView(row: DbRow, key: AccountDataKey): SharingArtifact {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    title: sharingDecrypt(key, "artifacts", String(row.id), "title_enc", String(row.title_enc)),
    sourceRevision: String(row.source_revision),
    currentHead: row.current_head as string | null,
    sectionIds: JSON.parse(String(row.selection_json)),
    bytes: Number(row.bytes),
    createdAt: Number(row.created_at),
    kind: row.kind as "document" | "handoff",
  };
}
export function grantView(row: DbRow, now: number): SharingGrant {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    mode: row.mode as SharingGrant["mode"],
    status:
      row.status === "active" && row.expires_at !== null && Number(row.expires_at) <= now
        ? "expired"
        : (row.status as SharingGrant["status"]),
    disabledReason: row.disabled_reason as string | null,
    expiresAt: row.expires_at as number | null,
    createdAt: Number(row.created_at),
    generation: Number(row.generation),
  };
}
export function artifactObjectContext(ownerId: string, id: string) {
  return { kind: "artifact", ownerId, objectId: id, formatVersion: 1 } as const;
}
