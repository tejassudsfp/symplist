import { type VaultGrantRequest, vaultGrantRequestSchema } from "@symplist/contracts";
import {
  type AccountDataKey,
  decryptFieldText,
  decryptVaultGrantValue,
  encryptFieldText,
  encryptVaultGrantValue,
  zeroize,
} from "@symplist/crypto";
import { type DbClient, type DbRow, int, sql, uuidv7 } from "@symplist/db";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import type { SimonRepository } from "../simon/repository.ts";
import type { ClaimedSimonRun } from "../simon/types.ts";
import { type VaultActor, VaultError, type VaultFold } from "./context.ts";
import { openItem } from "./items.ts";
import { disposeOpenVault, type VaultSessions } from "./sessions.ts";

const labelContext = (ownerId: string, id: string) => ({
  purpose: "vault_grant_label",
  ownerId,
  table: "vault_grants",
  rowId: id,
  column: "label_enc",
});
export class VaultGrants {
  constructor(readonly sessions: VaultSessions) {}
  async create(
    actor: VaultActor,
    token: string | undefined,
    input: VaultGrantRequest,
    fold?: VaultFold,
  ) {
    const body = vaultGrantRequestSchema.parse(input);
    const repo = this.sessions.repository;
    const open = await this.sessions.open(actor, token, true, fold);
    try {
      if (open.context.replay)
        return open.context.replay.body as {
          id: string;
          handle: { $vault: string };
          expiresAt: number;
        };
      if (body.expiresAt <= open.context.now || body.expiresAt > open.context.now + 86400000)
        throw new VaultError("validation");
      const row = await repo.options.db.first(
        sql(
          `SELECT * FROM vault_items WHERE id=:id AND owner_id=:vault_owner AND version=CAST(:version AS INTEGER) AND deleted_at IS NULL AND ${open.guard.exists}`,
          { ...open.guard.params, id: body.itemId, version: int(body.itemVersion) },
        ),
      );
      if (!row) throw new VaultError("vault.conflict");
      const item = openItem(open, row);
      const id = uuidv7(open.context.now);
      const bytes = Buffer.from(item.value);
      let encrypted: string;
      try {
        encrypted = encryptVaultGrantValue(
          open.context.key,
          { ownerId: actor.userId, grantId: id, taskId: body.taskId },
          bytes,
        );
      } finally {
        zeroize(bytes);
      }
      const result = await repo.mutate({
        context: open.context,
        ...(fold ? { fold } : {}),
        body: { id, handle: { $vault: id }, expiresAt: body.expiresAt },
        status: 201,
        failure: "vault.grant_revoked",
        plan: (claim, w) => {
          const effect = {
            exists: "EXISTS (SELECT 1 FROM vault_grants WHERE id=:grant AND write_id=:w)",
            params: { grant: id, w },
          };
          return {
            effect,
            statements: [
              sql(
                `INSERT INTO vault_grants
          (id,owner_id,item_id,item_version,task_id,conversation_id,tool_slug,argument_path,label_enc,expires_at,status,value_enc,created_at,write_id)
          SELECT :grant,:owner,:item,:item_version,:task,:conversation,:tool,:path,:label,:expires,'active',:value,:now,:w
          WHERE ${open.guard.exists} AND ${claim.exists}
            AND EXISTS (SELECT 1 FROM vault_items WHERE id=:item AND owner_id=:owner AND version=CAST(:item_version AS INTEGER) AND deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM tasks WHERE id=:task AND owner_id=:owner AND archived_at IS NULL)
            AND EXISTS (SELECT 1 FROM conversations WHERE id=:conversation AND owner_id=:owner AND task_id=:task AND kind='task')`,
                {
                  ...open.guard.params,
                  ...claim.params,
                  ...effect.params,
                  owner: actor.userId,
                  item: body.itemId,
                  item_version: int(body.itemVersion),
                  task: body.taskId,
                  conversation: body.conversationId,
                  tool: body.toolSlug,
                  path: body.argumentPath,
                  label: encryptFieldText(
                    open.context.key,
                    labelContext(actor.userId, id),
                    item.title,
                  ),
                  expires: int(body.expiresAt),
                  value: encrypted,
                  now: int(open.context.now),
                },
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
  async revoke(actor: VaultActor, token: string | undefined, id: string, fold?: VaultFold) {
    const open = await this.sessions.open(actor, token, true, fold);
    const repo = this.sessions.repository;
    try {
      if (open.context.replay) return { status: "revoked" };
      return (
        await repo.mutate({
          context: open.context,
          ...(fold ? { fold } : {}),
          body: { status: "revoked" },
          plan: (claim, w) => {
            const effect = {
              exists:
                "EXISTS (SELECT 1 FROM vault_grants WHERE id=:id AND owner_id=:owner AND write_id=:w)",
              params: { id, owner: actor.userId, w },
            };
            return {
              effect,
              statements: [
                sql(
                  `UPDATE vault_grants SET status='revoked',value_enc=NULL,write_id=:w WHERE id=:id AND owner_id=:owner AND ${open.guard.exists} AND ${claim.exists}`,
                  { ...effect.params, ...open.guard.params, ...claim.params },
                ),
              ],
            };
          },
        })
      ).body;
    } finally {
      disposeOpenVault(open);
    }
  }
}

export interface VaultExecutionContext {
  readonly kind: "task";
  readonly ownerId: string;
  readonly taskId: string;
  readonly conversationId: string;
  readonly toolSlug: string;
  readonly accountKey: AccountDataKey;
  readonly now: number;
  /** The executor generation/run guard, folded into the same read. */
  readonly guard: { exists: string; params: Readonly<Record<string, string>> };
}
interface Handle {
  id: string;
  path: string;
}
function handles(value: unknown, path = "", depth = 0): Handle[] {
  if (depth > 30) throw new VaultError("vault.grant_revoked");
  if (!value || typeof value !== "object") return [];
  if ("$vault" in value) {
    if (Object.keys(value).length !== 1 || typeof value.$vault !== "string")
      throw new VaultError("vault.grant_revoked");
    return [{ id: value.$vault, path }];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new VaultError("vault.grant_revoked");
    return handles(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, depth + 1);
  });
}

/**
 * The executor-facing Vault seam. It binds a resolution to the already claimed run and reuses the
 * same generation/cancellation/access fence as every other Simon effect. Quick chat gets an
 * identity redactor only when no handle exists; a handle is always refused there.
 */
export async function resolveClaimedVaultArguments(
  repository: SimonRepository,
  claim: ClaimedSimonRun,
  toolSlug: string,
  args: unknown,
) {
  if (claim.run.taskId === null) {
    if (handles(args).length) throw new VaultError("vault.grant_revoked");
    return {
      arguments: structuredClone(args),
      redact: (value: unknown) => value,
    };
  }
  return resolveVaultArguments(
    repository.options.db,
    repository.options.policy,
    {
      kind: "task",
      ownerId: claim.run.ownerId,
      taskId: claim.run.taskId,
      conversationId: claim.run.conversationId,
      toolSlug,
      accountKey: claim.key,
      now: repository.options.now(),
      guard: {
        exists: `EXISTS (SELECT 1 FROM runs WHERE id=:vault_run AND owner_id=:vault_run_owner
          AND executor_generation=:vault_run_generation AND ${repository.runGuard()})`,
        params: {
          vault_run: claim.run.id,
          vault_run_owner: claim.run.ownerId,
          vault_run_generation: int(claim.run.generation),
        },
      },
    },
    args,
  );
}
/** Worker-safe resolver: no Vault key, session token or recovery credential is available here. */
export async function resolveVaultArguments(
  db: DbClient,
  policy: AccessPolicy,
  context: VaultExecutionContext,
  args: unknown,
) {
  const found = handles(args);
  if (found.length > 20) throw new VaultError("vault.grant_revoked");
  if (context.kind !== "task" || context.accountKey.ownerId !== context.ownerId)
    throw new VaultError("vault.grant_revoked");
  const replacements = new Map<string, string>();
  const secrets: { value: string; label: string }[] = [];
  if (found.length) {
    const rows = await db.all(
      sql(
        `SELECT g.* FROM vault_grants g JOIN vault_items i ON i.id=g.item_id AND i.owner_id=g.owner_id
      JOIN tasks t ON t.id=g.task_id AND t.owner_id=g.owner_id
      JOIN conversations c ON c.id=g.conversation_id AND c.owner_id=g.owner_id
      WHERE g.id IN (:ids) AND g.owner_id=:vault_owner AND g.task_id=:task AND g.conversation_id=:conversation
        AND g.tool_slug=:tool AND g.status='active' AND g.expires_at>CAST(:now AS INTEGER) AND g.value_enc IS NOT NULL
        AND g.item_version=i.version AND i.deleted_at IS NULL AND t.archived_at IS NULL AND c.kind='task' AND c.task_id=t.id
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:vault_owner)
        AND ${accessCondition({ level: "admitted", policy, userParam: "vault_owner" })} AND ${context.guard.exists}`,
        {
          ...context.guard.params,
          ids: [...new Set(found.map((h) => h.id))],
          vault_owner: context.ownerId,
          task: context.taskId,
          conversation: context.conversationId,
          tool: context.toolSlug,
          now: int(context.now),
        },
      ),
    );
    const byId = new Map<string, DbRow>(rows.map((row) => [String(row.id), row]));
    for (const handle of found) {
      const row = byId.get(handle.id);
      if (!row || row.argument_path !== handle.path) throw new VaultError("vault.grant_revoked");
      const buffer = decryptVaultGrantValue(
        context.accountKey,
        { ownerId: context.ownerId, grantId: handle.id, taskId: context.taskId },
        String(row.value_enc),
      );
      try {
        const value = buffer.toString("utf8");
        const label = decryptFieldText(
          context.accountKey,
          labelContext(context.ownerId, handle.id),
          String(row.label_enc),
        );
        replacements.set(handle.path, value);
        secrets.push({ value, label });
      } finally {
        zeroize(buffer);
      }
    }
  }
  const clone = (value: unknown, path = ""): unknown => {
    if (replacements.has(path)) return replacements.get(path);
    if (Array.isArray(value)) return value.map((child, index) => clone(child, `${path}/${index}`));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          clone(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
        ]),
      );
    return value;
  };
  const forms = (value: string) =>
    [
      value,
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ].filter(Boolean);
  const hidden = secrets.flatMap(({ value }) => forms(value));
  const variants = secrets
    .flatMap(({ value, label }) => {
      // A user can put the credential in its label too. Never reintroduce it through
      // the replacement text; use a neutral label whenever there is any overlap.
      const safeLabel = hidden.some((secret) => label.includes(secret)) ? "item" : label;
      return forms(value).map((value) => ({ value, replacement: `[vault:${safeLabel}]` }));
    })
    .sort((a, b) => b.value.length - a.value.length);
  const redact = (value: unknown, depth = 0, seen = new Set<object>()): unknown => {
    if (depth > 30) return "[redacted: depth limit]";
    if (typeof value === "string") {
      let text = value;
      for (const variant of variants) text = text.split(variant.value).join(variant.replacement);
      return text;
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[redacted: circular reference]";
      const next = new Set(seen).add(value);
      if (Array.isArray(value)) return value.map((child) => redact(child, depth + 1, next));
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          String(redact(key)),
          redact(child, depth + 1, next),
        ]),
      );
    }
    return value;
  };
  return { arguments: clone(args), redact };
}
