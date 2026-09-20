import { type AccountDataKey, decryptFieldText } from "@symplist/crypto";
import { type DbClient, sql } from "@symplist/db";
import { accessCondition } from "../../../access/sql.ts";
import { preferencesContext } from "../../../preferences/service.ts";
import type { ChatOptInSource, SearchSourceContributor } from "../types.ts";

/** A malformed or unauthenticated privacy envelope fails closed: chat stays out of search. */
export class D1ChatOptInSource implements ChatOptInSource {
  constructor(
    private readonly db: DbClient,
    private readonly policy?: { readonly betaAccessRequired: boolean },
  ) {}

  async includeChat(ownerId: string, key: AccountDataKey): Promise<boolean> {
    const admitted = accessCondition({
      level: "admitted",
      policy: this.policy ?? { betaAccessRequired: true },
      userParam: "search_preferences_owner",
    });
    const row = await this.db.first(
      sql(
        `SELECT p.data_enc FROM user_preferences p WHERE p.owner_id = :owner AND p."group" = 'privacy'
         AND ${admitted}`,
        { owner: ownerId, search_preferences_owner: ownerId },
      ),
    );
    if (!row || typeof row.data_enc !== "string") return false;
    try {
      const value = JSON.parse(
        decryptFieldText(key, preferencesContext(ownerId, "privacy"), row.data_enc),
      ) as { includeChatInSearch?: unknown };
      return value.includeChatInSearch === true;
    } catch {
      return false;
    }
  }
}

/**
 * The preferences search source (§10.3). It adds `chatOptIn`: a `ChatOptInSource` reading the owner's
 * `privacy` preference group. Until it does, chat content is never included in search, which is the
 * opt-in default of §10.1.
 */
export const preferencesSearchSourceContributor: SearchSourceContributor = {
  domain: "preferences",
  chatOptIn: ({ db, accessPolicy }) => new D1ChatOptInSource(db, accessPolicy),
};
