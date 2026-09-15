import {
  type PreferenceDataByGroup,
  type PreferenceGroup,
  preferenceDataSchemas,
  preferenceDefaults,
  preferenceGroups,
} from "@symplist/contracts";
import type {
  AccountDataKey,
  FieldEnvelopeContext,
  KeyProvider,
  RandomOptions,
} from "@symplist/crypto";
import { canonicalJson, decryptFieldText, encryptFieldText, zeroize } from "@symplist/crypto";
import type { DbClient, DbRow } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { type AccessDenialCode, type AccessPolicy, evaluateAccess } from "../access/evaluate.ts";
import { ACCESS_STATE_COLUMNS, accessCondition, accessStateFromRow } from "../access/sql.ts";
import { AccountKeyStore, AccountKeyUnavailableError } from "../account/keys.ts";

/** Field envelope purpose of `user_preferences.data_enc` (§4.4, §10.3). */
export const PREFERENCES_PURPOSE = "preferences";

/** The envelope binding of one group: owner, table `user_preferences`, the group and `data_enc`. */
export function preferencesContext(ownerId: string, group: PreferenceGroup): FieldEnvelopeContext {
  return Object.freeze({
    purpose: PREFERENCES_PURPOSE,
    ownerId,
    table: "user_preferences",
    rowId: group,
    column: "data_enc",
  });
}

/** One group as stored (version 0 and the defaults before the first save). */
export interface PreferenceEntryValue<Group extends PreferenceGroup = PreferenceGroup> {
  readonly group: Group;
  readonly version: number;
  readonly data: PreferenceDataByGroup[Group];
  readonly updatedAt: number | null;
}

export type PreferenceEntries = {
  readonly [Group in PreferenceGroup]: PreferenceEntryValue<Group>;
};

/** The preferences of one owner with the wrapped key row they were read with. */
interface PreferencesState {
  readonly ownerId: string;
  readonly keyRow: DbRow;
  readonly entries: PreferenceEntries;
}

/** The api's in-memory preferences cache (§3.3), keyed by owner. */
export interface PreferencesCache {
  get(ownerId: string): PreferencesStateSnapshot | undefined;
  set(snapshot: PreferencesStateSnapshot): void;
  delete(ownerId: string): void;
}

/** What the cache holds for one owner. */
export type PreferencesStateSnapshot = PreferencesState;

/** A bounded {@link PreferencesCache} with a hard 60-second TTL per entry (§3.3). */
export class MemoryPreferencesCache implements PreferencesCache {
  private readonly entries = new Map<string, { snapshot: PreferencesState; expiresAt: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: {
    readonly now: () => number;
    readonly ttlMs?: number;
    readonly maxEntries?: number;
  }) {
    this.now = options.now;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 5_000;
  }

  get(ownerId: string): PreferencesState | undefined {
    const entry = this.entries.get(ownerId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(ownerId);
      return undefined;
    }
    return entry.snapshot;
  }

  set(snapshot: PreferencesState): void {
    this.entries.delete(snapshot.ownerId);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(snapshot.ownerId, { snapshot, expiresAt: this.now() + this.ttlMs });
  }

  delete(ownerId: string): void {
    this.entries.delete(ownerId);
  }
}

/** Invalid data for a group; `issues` follow the contracts validation issue shape. */
export class PreferencesValidationError extends Error {
  readonly code = "validation";
  readonly issues: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly code: string;
  }>;
  constructor(issues: PreferencesValidationError["issues"]) {
    super("Invalid preference data");
    this.name = "PreferencesValidationError";
    this.issues = issues;
  }
}

/** A refused preference save that is not a version conflict. */
export class PreferencesAccessError extends Error {
  readonly code: AccessDenialCode | "not_found";
  constructor(code: AccessDenialCode | "not_found") {
    super(`Preference save refused: ${code}`);
    this.name = "PreferencesAccessError";
    this.code = code;
  }
}

export type PreferencesPutResult<Group extends PreferenceGroup = PreferenceGroup> =
  | {
      readonly kind: "saved";
      readonly entry: PreferenceEntryValue<Group>;
      readonly clientSeq: number;
      /** False when the save was an exact retry of the stored data at the next version. */
      readonly changed: boolean;
    }
  | {
      /** `preferences.conflict`: the group's current version and data. */
      readonly kind: "conflict";
      readonly entry: PreferenceEntryValue<Group>;
      readonly clientSeq: number;
    };

export interface PreferencesServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly cache?: PreferencesCache;
  readonly random?: RandomOptions;
}

function isGroup(value: unknown): value is PreferenceGroup {
  return typeof value === "string" && (preferenceGroups as readonly string[]).includes(value);
}

/**
 * Parses stored or submitted data for a group. Stored data that no longer matches (an older shape)
 * reads as the defaults at its stored version, so the next save replaces it.
 */
function parseData<Group extends PreferenceGroup>(
  group: Group,
  value: unknown,
): PreferenceDataByGroup[Group] | null {
  const result = preferenceDataSchemas[group].safeParse(value);
  return result.success ? (result.data as PreferenceDataByGroup[Group]) : null;
}

/**
 * `core/preferences` (§10.3): versioned, encrypted preference groups. A save applies only when its
 * `baseVersion` is the stored version; otherwise it returns the current version and data, and an exact
 * retry of a save that already applied (same data at `baseVersion + 1`) counts as saved. Reads and
 * saves are one D1 request each (a save needs the account key first when the cache is cold).
 */
export class PreferencesService {
  private readonly db: DbClient;
  private readonly policy: AccessPolicy;
  private readonly now: () => number;
  private readonly cache: PreferencesCache | undefined;
  private readonly random: RandomOptions | undefined;
  private readonly accountKeys: AccountKeyStore;

  constructor(options: PreferencesServiceOptions) {
    this.db = options.db;
    this.policy = Object.freeze({ betaAccessRequired: options.policy.betaAccessRequired });
    this.now = options.now;
    this.cache = options.cache;
    this.random = options.random;
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  /** Every group, saved or default. */
  async getAll(ownerId: string): Promise<PreferenceEntries> {
    return (await this.state(ownerId)).entries;
  }

  /** One group. */
  async get<Group extends PreferenceGroup>(
    ownerId: string,
    group: Group,
  ): Promise<PreferenceEntryValue<Group>> {
    return (await this.state(ownerId)).entries[group] as PreferenceEntryValue<Group>;
  }

  /** Forgets an owner's cached preferences. */
  invalidate(ownerId: string): void {
    this.cache?.delete(ownerId);
  }

  /**
   * Validates the data for the group, or throws {@link PreferencesValidationError} with issues under
   * `data`.
   */
  validate<Group extends PreferenceGroup>(
    group: Group,
    data: unknown,
  ): PreferenceDataByGroup[Group] {
    if (!isGroup(group))
      throw new PreferencesValidationError([{ path: ["group"], code: "invalid_value" }]);
    const result = preferenceDataSchemas[group].safeParse(data);
    if (result.success) return result.data as PreferenceDataByGroup[Group];
    throw new PreferencesValidationError(
      result.error.issues.slice(0, 100).map((issue) => ({
        path: [
          "data",
          ...issue.path.filter((part): part is string | number => typeof part !== "symbol"),
        ],
        code: issue.code,
      })),
    );
  }

  /** Saves a group at `baseVersion` (`PUT /v1/preferences/:group`). */
  async put<Group extends PreferenceGroup>(input: {
    readonly ownerId: string;
    readonly group: Group;
    readonly baseVersion: number;
    readonly clientSeq: number;
    readonly data: unknown;
  }): Promise<PreferencesPutResult<Group>> {
    const data = this.validate(input.group, input.data);
    const state = await this.state(input.ownerId);
    const now = this.now();
    const writeId = uuidv7(now);
    const key = this.accountKeys.unwrapRow(state.keyRow);
    try {
      const envelope = encryptFieldText(
        key,
        preferencesContext(input.ownerId, input.group),
        JSON.stringify(data),
        this.random,
      );
      const access = accessCondition({
        level: "admitted",
        policy: this.policy,
        userParam: "owner",
      });
      const deciding =
        input.baseVersion === 0
          ? sql(
              `INSERT INTO user_preferences (owner_id, "group", version, data_enc, updated_at, write_id)
               SELECT :owner, :group, 1, :data, :now, :w
               WHERE ${access} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
               ON CONFLICT (owner_id, "group") DO NOTHING`,
              {
                owner: input.ownerId,
                group: input.group,
                data: envelope,
                now: int(now),
                w: writeId,
              },
            )
          : sql(
              `UPDATE user_preferences SET version = version + 1, data_enc = :data, updated_at = :now, write_id = :w
               WHERE owner_id = :owner AND "group" = :group AND version = CAST(:base AS INTEGER)
                 AND ${access}`,
              {
                data: envelope,
                now: int(now),
                w: writeId,
                owner: input.ownerId,
                group: input.group,
                base: int(input.baseVersion),
              },
            );
      const results = await this.db.batch([
        deciding,
        this.accountKeys.selectStatement(input.ownerId),
        sql(`SELECT ${ACCESS_STATE_COLUMNS.join(", ")} FROM users WHERE id = :owner`, {
          owner: input.ownerId,
        }),
        sql(
          `SELECT version, data_enc, updated_at FROM user_preferences
           WHERE owner_id = :owner AND "group" = :group`,
          { owner: input.ownerId, group: input.group },
        ),
        sql(
          `SELECT version, updated_at FROM user_preferences
           WHERE owner_id = :owner AND "group" = :group AND write_id = :w`,
          { owner: input.ownerId, group: input.group, w: writeId },
        ),
      ]);
      const keyRow = results[1]?.results[0];
      const userRow = results[2]?.results[0];
      const currentRow = results[3]?.results[0];
      const verified = results[4]?.results[0];
      if (verified) {
        const entry: PreferenceEntryValue<Group> = {
          group: input.group,
          version: Number(verified.version),
          data,
          updatedAt: Number(verified.updated_at),
        };
        this.remember(state, keyRow, entry);
        return { kind: "saved", entry, clientSeq: input.clientSeq, changed: true };
      }
      if (!keyRow || !userRow) throw new PreferencesAccessError("not_found");
      const decision = evaluateAccess(accessStateFromRow(userRow), "admitted", this.policy);
      if (!decision.allowed) throw new PreferencesAccessError(decision.code);
      const current = this.entryFromRow(input.ownerId, input.group, currentRow, key);
      this.remember(state, keyRow, current);
      if (
        current.version === input.baseVersion + 1 &&
        canonicalJson(current.data) === canonicalJson(data)
      ) {
        return { kind: "saved", entry: current, clientSeq: input.clientSeq, changed: false };
      }
      return { kind: "conflict", entry: current, clientSeq: input.clientSeq };
    } finally {
      zeroize(key.key);
    }
  }

  private async state(ownerId: string): Promise<PreferencesState> {
    const cached = this.cache?.get(ownerId);
    if (cached) return cached;
    const results = await this.db.batch([
      this.accountKeys.selectStatement(ownerId),
      sql(
        `SELECT "group", version, data_enc, updated_at FROM user_preferences WHERE owner_id = :owner`,
        {
          owner: ownerId,
        },
      ),
    ]);
    const keyRow = results[0]?.results[0];
    if (!keyRow) throw new AccountKeyUnavailableError();
    const key = this.accountKeys.unwrapRow(keyRow);
    try {
      const rows = new Map<string, DbRow>();
      for (const row of results[1]?.results ?? []) {
        if (typeof row.group === "string") rows.set(row.group, row);
      }
      const entries = Object.fromEntries(
        preferenceGroups.map((group) => [
          group,
          this.entryFromRow(ownerId, group, rows.get(group), key),
        ]),
      ) as unknown as PreferenceEntries;
      const state: PreferencesState = { ownerId, keyRow, entries };
      this.cache?.set(state);
      return state;
    } finally {
      zeroize(key.key);
    }
  }

  private entryFromRow<Group extends PreferenceGroup>(
    ownerId: string,
    group: Group,
    row: DbRow | undefined,
    key: AccountDataKey,
  ): PreferenceEntryValue<Group> {
    if (!row) {
      return { group, version: 0, data: preferenceDefaults[group], updatedAt: null };
    }
    const version = Number(row.version);
    const updatedAt = Number(row.updated_at);
    let data: PreferenceDataByGroup[Group] | null = null;
    if (typeof row.data_enc === "string") {
      const text = decryptFieldText(key, preferencesContext(ownerId, group), row.data_enc);
      try {
        data = parseData(group, JSON.parse(text));
      } catch {
        data = null;
      }
    }
    return { group, version, data: data ?? preferenceDefaults[group], updatedAt };
  }

  private remember<Group extends PreferenceGroup>(
    state: PreferencesState,
    keyRow: DbRow | undefined,
    entry: PreferenceEntryValue<Group>,
  ): void {
    if (!this.cache) return;
    if (!keyRow) {
      this.cache.delete(state.ownerId);
      return;
    }
    this.cache.set({
      ownerId: state.ownerId,
      keyRow,
      entries: { ...state.entries, [entry.group]: entry } as PreferenceEntries,
    });
  }
}
