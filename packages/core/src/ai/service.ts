import type {
  AiModelChoicesInput,
  AiProvider,
  AiSettings,
  AiTier,
  AiTierChoice,
} from "@symplist/contracts";
import { decryptFieldText, encryptFieldText, type KeyProvider, zeroize } from "@symplist/crypto";
import { type DbClient, type DbRow, int, sql, uuidv7 } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";
import { providerKeyContext } from "./fields.ts";

/**
 * Bring-your-own-key model access (§8.6).
 *
 * A run uses the provider key belonging to the account it runs for, decrypted in the executor that
 * is about to make the call and zeroized straight after. There is no deployment-wide fallback: an
 * account without a usable key is told to add one, and is never quietly spent against somebody
 * else's credential.
 *
 * The one rule every method here keeps is that a key travels in one direction. It arrives from its
 * owner, it is sealed under the account data key, and the only thing that ever unseals it is a
 * model call. Nothing on the read path returns it, not even to its owner — `status` says a key
 * exists and when, and that is the whole vocabulary the settings screen has.
 */

export const AI_PROVIDERS: readonly AiProvider[] = Object.freeze(["openai", "anthropic"]);
export const AI_TIERS: readonly AiTier[] = Object.freeze(["fast", "smart"]);

/**
 * Model ids offered in the settings screen.
 *
 * A convenience, not an allowlist: a provider ships models faster than we deploy, so the screen also
 * takes a typed id and the run reports what the provider says about it. Gating on this list would
 * mean a new model could not be used until Symplist shipped, which is exactly the coupling BYOK is
 * supposed to remove.
 */
export const AI_MODEL_SUGGESTIONS: readonly { provider: AiProvider; models: readonly string[] }[] =
  Object.freeze([
    Object.freeze({
      provider: "openai" as const,
      models: Object.freeze(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6", "gpt-5.5"]),
    }),
    Object.freeze({
      provider: "anthropic" as const,
      models: Object.freeze([
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
      ]),
    }),
  ]);

/** The deployment's fallback model for each tier, used until an account chooses its own. */
export interface AiTierDefaults {
  readonly fast: { readonly provider: AiProvider; readonly model: string };
  readonly smart: { readonly provider: AiProvider; readonly model: string };
}

export interface AiKeyStoreOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly defaults: AiTierDefaults;
  readonly now: () => number;
}

/** A decrypted provider key. The caller zeroizes nothing: `use` does it. */
export interface ResolvedModelCredential {
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiKey: string;
}

export class AiKeyRequiredError extends Error {
  readonly code = "ai.key_required" as const;
  constructor(readonly tier: AiTier) {
    super("ai.key_required");
    this.name = "AiKeyRequiredError";
  }
}

interface KeyRow {
  readonly provider: AiProvider;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly verifiedAt: number | null;
}

function toProvider(value: unknown): AiProvider {
  if (value !== "openai" && value !== "anthropic") {
    throw new Error("ai_provider_keys.provider holds an unknown value");
  }
  return value;
}

export class AiKeyStore {
  private readonly db: DbClient;
  private readonly accountKeys: AccountKeyStore;
  private readonly defaults: AiTierDefaults;
  private readonly now: () => number;

  constructor(options: AiKeyStoreOptions) {
    this.db = options.db;
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
    this.defaults = options.defaults;
    this.now = options.now;
  }

  /** Stores a key, replacing whatever that provider had. A replacement is unverified again. */
  async setKey(ownerId: string, provider: AiProvider, apiKey: string): Promise<void> {
    const key = await this.accountKeys.require(ownerId);
    let sealed: string;
    try {
      sealed = encryptFieldText(key, providerKeyContext(ownerId, provider), apiKey);
    } finally {
      zeroize(key.key);
    }
    const now = this.now();
    await this.db.run(
      sql(
        `INSERT INTO ai_provider_keys (owner_id, provider, key_enc, created_at, updated_at, verified_at, write_id)
         VALUES (:owner, :provider, :enc, :now, :now, NULL, :w)
         ON CONFLICT (owner_id, provider) DO UPDATE SET
           key_enc = excluded.key_enc,
           updated_at = excluded.updated_at,
           -- A new key has not been shown to work yet, whatever the old one did.
           verified_at = NULL,
           write_id = excluded.write_id`,
        { owner: ownerId, provider, enc: sealed, now: int(now), w: uuidv7(now) },
      ),
    );
  }

  /** Removes a key. A tier pointing at that provider stops being ready; its choice is untouched. */
  async clearKey(ownerId: string, provider: AiProvider): Promise<void> {
    await this.db.run(
      sql(`DELETE FROM ai_provider_keys WHERE owner_id = :owner AND provider = :provider`, {
        owner: ownerId,
        provider,
      }),
    );
  }

  /** Records that a live call with this key succeeded, so the screen can say so. */
  async markVerified(ownerId: string, provider: AiProvider): Promise<void> {
    const now = this.now();
    await this.db.run(
      sql(
        `UPDATE ai_provider_keys SET verified_at = :now, write_id = :w
         WHERE owner_id = :owner AND provider = :provider`,
        { owner: ownerId, provider, now: int(now), w: uuidv7(now) },
      ),
    );
  }

  private async keyRows(ownerId: string): Promise<readonly KeyRow[]> {
    const rows = await this.db.all(
      sql(
        `SELECT provider, created_at, updated_at, verified_at FROM ai_provider_keys
         WHERE owner_id = :owner`,
        { owner: ownerId },
      ),
    );
    return rows.map((row: DbRow) => ({
      provider: toProvider(row.provider),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      verifiedAt:
        row.verified_at === null || row.verified_at === undefined ? null : Number(row.verified_at),
    }));
  }

  private async choiceRow(ownerId: string): Promise<DbRow | null> {
    return await this.db.first(
      sql(
        `SELECT fast_provider, fast_model, smart_provider, smart_model FROM ai_model_choices
         WHERE owner_id = :owner`,
        { owner: ownerId },
      ),
    );
  }

  /** What answers a tier: the account's choice where it made one, the deployment default otherwise. */
  private resolveTier(
    tier: AiTier,
    row: DbRow | null,
  ): { provider: AiProvider; model: string; chosen: boolean } {
    const fallback = this.defaults[tier];
    const provider = row?.[`${tier}_provider`];
    const model = row?.[`${tier}_model`];
    const chosenProvider = provider === "openai" || provider === "anthropic" ? provider : null;
    const chosenModel = typeof model === "string" && model.length > 0 ? model : null;
    return {
      provider: chosenProvider ?? fallback.provider,
      model: chosenModel ?? fallback.model,
      chosen: chosenProvider !== null || chosenModel !== null,
    };
  }

  /** Everything the settings screen shows. No key, and no part of one, is in here. */
  async settings(ownerId: string): Promise<AiSettings> {
    const [rows, choices] = await Promise.all([this.keyRows(ownerId), this.choiceRow(ownerId)]);
    const configured = new Map(rows.map((row) => [row.provider, row]));
    const tiers: AiTierChoice[] = AI_TIERS.map((tier) => {
      const resolved = this.resolveTier(tier, choices);
      return {
        tier,
        provider: resolved.provider,
        model: resolved.model,
        ready: configured.has(resolved.provider),
        chosen: resolved.chosen,
      };
    });
    return {
      keys: AI_PROVIDERS.map((provider) => {
        const row = configured.get(provider);
        return {
          provider,
          configured: row !== undefined,
          createdAt: row?.createdAt ?? null,
          updatedAt: row?.updatedAt ?? null,
          verifiedAt: row?.verifiedAt ?? null,
        };
      }),
      tiers,
      usable: tiers.some((tier) => tier.ready),
      suggestions: AI_MODEL_SUGGESTIONS.map((entry) => ({
        provider: entry.provider,
        models: [...entry.models],
      })),
    };
  }

  /** Chooses what answers each tier. An omitted field stays; an explicit null returns to default. */
  async setChoices(ownerId: string, input: AiModelChoicesInput): Promise<void> {
    const existing = await this.choiceRow(ownerId);
    const next = (tier: AiTier, column: "provider" | "model"): string | null => {
      const change = input[tier];
      const key = column as keyof NonNullable<typeof change>;
      if (change && Object.hasOwn(change, key)) return (change[key] as string | null) ?? null;
      const current = existing?.[`${tier}_${column}`];
      return typeof current === "string" ? current : null;
    };
    const now = this.now();
    await this.db.run(
      sql(
        `INSERT INTO ai_model_choices
           (owner_id, fast_provider, fast_model, smart_provider, smart_model, updated_at, write_id)
         VALUES (:owner, :fp, :fm, :sp, :sm, :now, :w)
         ON CONFLICT (owner_id) DO UPDATE SET
           fast_provider = excluded.fast_provider,
           fast_model = excluded.fast_model,
           smart_provider = excluded.smart_provider,
           smart_model = excluded.smart_model,
           updated_at = excluded.updated_at,
           write_id = excluded.write_id`,
        {
          owner: ownerId,
          fp: next("fast", "provider"),
          fm: next("fast", "model"),
          sp: next("smart", "provider"),
          sm: next("smart", "model"),
          now: int(now),
          w: uuidv7(now),
        },
      ),
    );
  }

  /**
   * The credential a tier runs with, decrypted.
   *
   * Throws `ai.key_required` when the account has not given a key for the provider that tier names.
   * That is deliberately the same answer whether no key was ever added or the one for this provider
   * was removed: both mean the owner has to go and add one, and neither is a failure of the run.
   */
  async credentialFor(ownerId: string, tier: AiTier): Promise<ResolvedModelCredential> {
    const choices = await this.choiceRow(ownerId);
    const resolved = this.resolveTier(tier, choices);
    const row = await this.db.first(
      sql(`SELECT key_enc FROM ai_provider_keys WHERE owner_id = :owner AND provider = :provider`, {
        owner: ownerId,
        provider: resolved.provider,
      }),
    );
    if (!row) throw new AiKeyRequiredError(tier);
    const key = await this.accountKeys.require(ownerId);
    try {
      return {
        provider: resolved.provider,
        model: resolved.model,
        apiKey: decryptFieldText(
          key,
          providerKeyContext(ownerId, resolved.provider),
          String(row.key_enc),
        ),
      };
    } finally {
      zeroize(key.key);
    }
  }

  /**
   * Whether any tier can run, for the gate that decides if Simon is offered at all.
   *
   * Deliberately not "does the account have a key": a key for a provider that neither tier points
   * at runs nothing, and answering `true` there would offer an assistant that fails on first use.
   * This is the same question `settings().usable` answers, and must keep the same answer.
   */
  async usable(ownerId: string): Promise<boolean> {
    const choices = await this.choiceRow(ownerId);
    const providers = [
      ...new Set(AI_TIERS.map((tier) => this.resolveTier(tier, choices).provider)),
    ];
    const row = await this.db.first(
      sql(
        `SELECT EXISTS (
           SELECT 1 FROM ai_provider_keys WHERE owner_id = :owner AND provider IN (:a, :b)
         ) AS present`,
        // Both tiers may resolve to one provider; repeating it keeps the parameter count fixed.
        { owner: ownerId, a: providers[0] ?? null, b: providers[1] ?? providers[0] ?? null },
      ),
    );
    return Number(row?.present ?? 0) === 1;
  }
}
