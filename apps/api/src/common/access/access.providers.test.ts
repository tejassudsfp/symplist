import type { AccountDeletionService } from "@symplist/core/account";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { REALTIME_ACCESS_NOTIFIER, type RealtimeAccessNotifier } from "../seams.ts";
import { ACCOUNT_DELETION, ACCOUNT_DELETION_EFFECTS } from "./access.providers.ts";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("account deletion through the api platform (§5.6)", () => {
  it("revokes sessions at once, evicts caches and runs restriction and deletion effects", async () => {
    const realtime: RealtimeAccessNotifier = {
      accessRestricted: vi.fn(async () => undefined),
      sessionsEnded: vi.fn(async () => undefined),
    };
    const posthog = { name: "posthog_person_deletion", afterCommit: vi.fn(async () => undefined) };
    app = await bootTestApp({
      providers: [
        { provide: REALTIME_ACCESS_NOTIFIER, useValue: realtime },
        { provide: ACCOUNT_DELETION_EFFECTS, useValue: [posthog] },
      ],
    });
    const user = await app.createSignedInUser("relocked");
    expect((await app.get("/v1/auth/csrf", { session: user.session })).status).toBe(200);

    const now = app.clock.now();
    const challengeId = uuidv7(now);
    const authorizationId = uuidv7(now);
    await app.db.batch([
      sql(
        `INSERT INTO otp_challenges (id, user_id, purpose, auth_session_id, code_digest, digest_version,
           created_at, expires_at, consumed_at, write_id)
         VALUES (:id, :user, 'account_delete', :session, 'digest', 1, :now, :exp, :now, 'w')`,
        {
          id: challengeId,
          user: user.id,
          session: user.session.sessionId,
          now: int(now),
          exp: int(now + 600_000),
        },
      ),
      sql(
        `INSERT INTO account_delete_authorizations (id, user_id, auth_session_id, challenge_id, created_at,
           expires_at, consumed_at, write_id)
         VALUES (:id, :user, :session, :challenge, :now, :exp, NULL, 'w')`,
        {
          id: authorizationId,
          user: user.id,
          session: user.session.sessionId,
          challenge: challengeId,
          now: int(now),
          exp: int(now + 600_000),
        },
      ),
    ]);

    const deletion = app.inject<AccountDeletionService>(ACCOUNT_DELETION);
    const result = await deletion.delete({
      userId: user.id,
      authorizationId,
      authSessionId: user.session.sessionId,
      now,
    });
    expect(result.status).toBe("deleted");
    expect((await app.get("/v1/auth/csrf", { session: user.session })).status).toBe(401);
    expect(await app.accountKeys.load(user.id)).toBeNull();
    expect(realtime.accessRestricted).toHaveBeenCalledWith({
      userId: user.id,
      reason: "deleted",
      accessGeneration: 1,
    });
    expect(posthog.afterCommit).toHaveBeenCalledWith({
      userId: user.id,
      analyticsId: null,
      committedAt: now,
    });
    expect(app.logs.text()).not.toContain(user.email);
  });
});
