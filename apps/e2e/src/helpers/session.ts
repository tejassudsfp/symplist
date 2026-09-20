import type { BrowserContext } from "@playwright/test";
import { localDataPaths } from "@symplist/config";
import { apiSecretFamilies } from "@symplist/config/api";
import { access } from "@symplist/core";
import { AccountKeyStore } from "@symplist/core/account";
import { createEnvKeyProvider } from "@symplist/crypto";
import { createLocalSqliteClient, int, sql, uuidv7 } from "@symplist/db";
import { SESSION_HINT_COOKIE } from "./identity.ts";
import { readRunEnv } from "./local-api.ts";

/**
 * A signed-in account for a browser context. There are no sign-in routes yet (§5.1 is still a
 * placeholder in the web app), so the suite writes the account and its session straight into the
 * api's own local D1 file with the api's own key provider, exactly as the sign-in route will.
 */
export interface SignedIn {
  readonly userId: string;
  readonly email: string;
}

export interface SignInOptions {
  /** Most feature specs have already made a privacy choice so the consent banner cannot mask UI. */
  readonly analyticsConsent?: "unset" | "denied";
}

/** The api's development session cookie; production's `__Host-` prefix needs HTTPS (§5.1). */
const SESSION_COOKIE = "sym_session";

/**
 * Creates an admitted account with a live session and puts its cookie in `context`.
 *
 * The cookie is set on the **api** origin. The web app calls the api cross-origin but same-site
 * (both `127.0.0.1`, different ports), so a `SameSite=Lax` cookie is sent with its requests.
 */
export async function signIn(
  context: BrowserContext,
  options: SignInOptions = {},
): Promise<SignedIn> {
  const env = readRunEnv();
  const now = Date.now();
  const db = createLocalSqliteClient({
    // The same environment the api was started with, so the seeder never diverges from it.
    path: localDataPaths(env.LOCAL_DATA_DIR as string).database,
    env: { NODE_ENV: env.NODE_ENV ?? "test" },
  });
  const keys = createEnvKeyProvider(env, { families: apiSecretFamilies });
  try {
    const userId = uuidv7(now);
    const email = `e2e-${userId}@example.test`;
    const analyticsConsent = options.analyticsConsent ?? "denied";
    await db.batch([
      sql(
        `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step,
           analytics_consent, analytics_consent_at, created_at, updated_at, write_id)
         VALUES (:id, :email, :now, 'unlocked', 'done', :consent, :decided, :now, :now, :w)`,
        {
          id: userId,
          email,
          now: int(now),
          consent: analyticsConsent,
          decided: analyticsConsent === "unset" ? null : int(now),
          w: uuidv7(now),
        },
      ),
      new AccountKeyStore({ db, keys }).provisionStatement({ userId, now }),
    ]);
    const session = await new access.SessionStore({ db, keys }).create({ userId, now });
    if (!session) throw new Error("the api's database refused the e2e session");

    const apiOrigin = env.API_ORIGIN as string;
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: session.token,
        url: apiOrigin,
        httpOnly: true,
        sameSite: "Lax",
      },
      // The web proxy reads this non-secret cookie to decide whether to redirect a visitor to
      // sign-in (§5.1); without it the signed-in pages bounce before the api is ever called.
      { name: SESSION_HINT_COOKIE, value: "1", url: env.WEB_ORIGIN as string, sameSite: "Lax" },
    ]);
    return { userId, email };
  } finally {
    keys.destroy();
    db.close?.();
  }
}
