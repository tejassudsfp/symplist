/**
 * The seam between this lane and the cloud-session lane's `McpGrantStore`.
 *
 * That store already owns the parts of a grant's life that belong to a session: it mints at sign-in,
 * re-mints inside three days of expiry, revokes *before* the sign-out that would take away the authority
 * to revoke, and keeps the key in the `safeStorage` secret store. None of that is duplicated here.
 *
 * What it does not own is the case this lane exists for: a grant that dies while the session lives —
 * revoked from the web UI, or expired on a machine left open. `McpGrantStore` learns nothing about that,
 * because it is only consulted at the session's edges. So this module adds two operations on top of its
 * public surface and nothing else.
 *
 * `replace()` is composed from the credential hooks rather than from a new method on that store, so this
 * lane adds no lines to another lane's file. The ordering it produces is revoke-then-mint, which is the
 * opposite of what a renewal wants — but this path only runs on a grant that is already dead, where there
 * is nothing left to lose by revoking first, and `McpGrantStore.established` already renews that way.
 */

/** The grant the relay authenticates with. `key` never leaves the main process. */
export interface DeviceGrant {
  readonly grantId: string;
  readonly key: string;
  readonly expiresAt: number;
}

/**
 * What this lane needs of a device grant. Two methods, both of which the cloud lane's `McpGrantStore`
 * can satisfy through `deviceGrantSource` below.
 */
export interface DeviceGrantSource {
  /** The grant held right now, or `null` when the device has none. */
  current(): DeviceGrant | null;
  /** Retires whatever is held and mints a replacement. Must not throw. */
  replace(): Promise<void>;
}

/** The part of `McpGrantStore` this adapter uses: its public credential hooks plus `current`. */
export interface GrantStoreLike {
  current(): DeviceGrant | null;
  established(identity: {
    readonly destination: string;
    readonly accessGeneration: number;
  }): Promise<void>;
  beforeSignOut(): Promise<void>;
  cleared(): Promise<void>;
}

/**
 * Adapts the cloud lane's grant store.
 *
 * `identity()` answers with the signed-in account's current snapshot, or `null` when there is no session:
 * `established` needs one, and minting requires a fresh admitted session, so a replacement cannot be
 * minted for an account that is signed out or still at the beta gate. Returning `null` there is the right
 * answer rather than an error — the app is in its `signed_out` state and there is nothing to grant.
 */
export function deviceGrantSource(
  store: GrantStoreLike,
  identity: () => { readonly destination: string; readonly accessGeneration: number } | null,
): DeviceGrantSource {
  return {
    current: () => store.current(),
    replace: async () => {
      await store.beforeSignOut();
      await store.cleared();
      const snapshot = identity();
      if (snapshot === null) return;
      await store.established(snapshot);
    },
  };
}
