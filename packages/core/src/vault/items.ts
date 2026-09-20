import {
  type VaultItem,
  type VaultItemContent,
  type VaultItemsResponse,
  vaultItemContentSchema,
} from "@symplist/contracts";
import { decryptVaultItem, encryptVaultItem, zeroize } from "@symplist/crypto";
import { type DbRow, int, sql, uuidv7 } from "@symplist/db";
import { type VaultActor, VaultError, type VaultFold } from "./context.ts";
import { disposeOpenVault, type OpenVault, type VaultSessions } from "./sessions.ts";

export function openItem(open: OpenVault, row: DbRow): VaultItem {
  const buffer = decryptVaultItem(
    open.vaultKey,
    { ownerId: open.context.actor.userId, itemId: String(row.id) },
    String(row.data_enc),
  );
  try {
    return {
      ...vaultItemContentSchema.parse(JSON.parse(buffer.toString("utf8"))),
      id: String(row.id),
      version: Number(row.version),
      updatedAt: Number(row.updated_at),
    };
  } finally {
    zeroize(buffer);
  }
}
export class VaultItems {
  constructor(readonly sessions: VaultSessions) {}
  async list(
    actor: VaultActor,
    token: string | undefined,
    cursor?: string,
  ): Promise<VaultItemsResponse> {
    const open = await this.sessions.open(actor, token);
    try {
      const rows = await this.sessions.repository.options.db.all(
        sql(
          // A 64k-character note can expand sixfold in JSON before envelope base64.
          // Sixteen rows (15 + cursor probe) stay below D1's 10 MiB result ceiling.
          `SELECT * FROM vault_items WHERE owner_id=:vault_owner AND deleted_at IS NULL AND id>:cursor AND ${open.guard.exists} ORDER BY id LIMIT 16`,
          { ...open.guard.params, cursor: cursor ?? "" },
        ),
      );
      return {
        items: rows.slice(0, 15).map((row) => {
          const { value: _value, ...summary } = openItem(open, row);
          return summary;
        }),
        nextCursor: rows.length > 15 ? String(rows[14]?.id) : null,
        idleExpiresAt: open.idleExpiresAt,
      };
    } finally {
      disposeOpenVault(open);
    }
  }
  async read(actor: VaultActor, token: string | undefined, id: string): Promise<VaultItem> {
    const open = await this.sessions.open(actor, token);
    try {
      const row = await this.sessions.repository.options.db.first(
        sql(
          `SELECT * FROM vault_items WHERE id=:id AND owner_id=:vault_owner AND deleted_at IS NULL AND ${open.guard.exists}`,
          { ...open.guard.params, id },
        ),
      );
      if (!row) throw new VaultError("not_found");
      return openItem(open, row);
    } finally {
      disposeOpenVault(open);
    }
  }
  async save(
    actor: VaultActor,
    token: string | undefined,
    input: VaultItemContent,
    existing?: { id: string; version: number },
    fold?: VaultFold,
  ) {
    const data = vaultItemContentSchema.parse(input);
    const repo = this.sessions.repository;
    const open = await this.sessions.open(actor, token, true, fold);
    try {
      if (open.context.replay) return open.context.replay.body as { id: string; version: number };
      const id = existing?.id ?? uuidv7(open.context.now);
      const version = (existing?.version ?? 0) + 1;
      const plaintext = Buffer.from(JSON.stringify(data));
      let encrypted: string;
      try {
        encrypted = encryptVaultItem(
          open.vaultKey,
          { ownerId: actor.userId, itemId: id },
          plaintext,
        );
      } finally {
        zeroize(plaintext);
      }
      const result = await repo.mutate({
        context: open.context,
        ...(fold ? { fold } : {}),
        body: { id, version },
        status: existing ? 200 : 201,
        plan: (claim, w) => {
          const effect = {
            exists:
              "EXISTS (SELECT 1 FROM vault_items WHERE id=:item AND owner_id=:owner AND write_id=:w)",
            params: { item: id, owner: actor.userId, w },
          };
          const params = {
            ...open.guard.params,
            ...claim.params,
            ...effect.params,
            data: encrypted,
            now: int(open.context.now),
            ...(existing ? { version: int(existing.version) } : {}),
          };
          const statement = existing
            ? sql(
                `UPDATE vault_items SET data_enc=:data,version=version+1,updated_at=:now,write_id=:w WHERE id=:item AND owner_id=:owner AND version=CAST(:version AS INTEGER) AND deleted_at IS NULL AND ${open.guard.exists} AND ${claim.exists}`,
                params,
              )
            : sql(
                `INSERT INTO vault_items (id,owner_id,version,data_enc,created_at,updated_at,deleted_at,write_id) SELECT :item,:owner,1,:data,:now,:now,NULL,:w WHERE ${open.guard.exists} AND ${claim.exists}`,
                params,
              );
          return {
            effect,
            statements: [
              statement,
              sql(
                `UPDATE vault_grants SET status='revoked',value_enc=NULL,write_id=:grant_write WHERE owner_id=:owner AND item_id=:item AND status='active' AND ${effect.exists}`,
                { ...effect.params, grant_write: uuidv7(open.context.now) },
              ),
            ],
          };
        },
      });
      return result.body;
    } finally {
      disposeOpenVault(open);
    }
  }
  async delete(
    actor: VaultActor,
    token: string | undefined,
    id: string,
    version: number,
    fold?: VaultFold,
  ) {
    const open = await this.sessions.open(actor, token, true, fold);
    const repo = this.sessions.repository;
    try {
      if (open.context.replay) return { status: "deleted" };
      const result = await repo.mutate({
        context: open.context,
        ...(fold ? { fold } : {}),
        body: { status: "deleted" },
        plan: (claim, w) => {
          const effect = {
            exists:
              "EXISTS (SELECT 1 FROM vault_items WHERE id=:item AND owner_id=:owner AND write_id=:w)",
            params: { item: id, owner: actor.userId, w },
          };
          return {
            effect,
            statements: [
              sql(
                `UPDATE vault_items SET deleted_at=:now,data_enc='',version=version+1,write_id=:w WHERE id=:item AND owner_id=:owner AND deleted_at IS NULL AND version=CAST(:version AS INTEGER) AND ${open.guard.exists} AND ${claim.exists}`,
                {
                  ...effect.params,
                  ...open.guard.params,
                  ...claim.params,
                  now: int(open.context.now),
                  version: int(version),
                },
              ),
              sql(
                `UPDATE vault_grants SET status='revoked',value_enc=NULL,write_id=:grant_write WHERE owner_id=:owner AND item_id=:item AND status='active' AND ${effect.exists}`,
                { ...effect.params, grant_write: uuidv7(open.context.now) },
              ),
            ],
          };
        },
      });
      return result.body;
    } finally {
      disposeOpenVault(open);
    }
  }
}
