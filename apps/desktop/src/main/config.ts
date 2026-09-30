/**
 * The cloud the app talks to.
 *
 * Two origins, and they are not interchangeable. `apiOrigin` is where requests go. `webOrigin` is the
 * value of the `Origin` header they carry, because the api pins its first-party client by string
 * equality against its own `WEB_ORIGIN` (`apps/api/src/common/guards/route-class.guard.ts`,
 * `checkOrigin`) — for the `pre_session` sign-in routes on every method, and for `app` routes on every
 * unsafe method. A desktop app has no web origin of its own, so it presents the deployment's.
 *
 * Both are normalised through `new URL(value).origin`, which is the only reason a trailing slash in an
 * environment file does not turn into an `auth.origin_forbidden` that looks like a server fault: the
 * comparison on the api side is `===` against a string with no path and no trailing slash.
 *
 * These are build-time values for the closed beta. The frontend is a Next build staged inside the app
 * and the origins are baked into the bundle, so pointing the app at another cloud means another build.
 * The environment overrides exist for development against a local api, not as user configuration.
 */

/** The closed beta's cloud. Public hostnames; nothing here is a secret. */
const DEFAULT_API_ORIGIN = "https://api.symplist.tejassuds.com";
const DEFAULT_WEB_ORIGIN = "https://app.symplist.tejassuds.com";

/** Overrides, for running the desktop app against a local api during development. */
export const API_ORIGIN_ENV = "SYMPLIST_DESKTOP_API_ORIGIN";
export const WEB_ORIGIN_ENV = "SYMPLIST_DESKTOP_WEB_ORIGIN";

export interface CloudConfig {
  /** Where requests go, for example `https://api.example`. No path, no trailing slash. */
  readonly apiOrigin: string;
  /** The `Origin` header every request carries: the api's configured `WEB_ORIGIN`, exactly. */
  readonly webOrigin: string;
}

/** Raised when an override is set to something that is not an http(s) origin. */
export class CloudConfigError extends Error {
  constructor(variable: string, value: string) {
    // The value is an origin the operator typed, never a credential, so echoing it is what makes the
    // failure fixable.
    super(`${variable} is not an http or https origin: ${JSON.stringify(value)}`);
    this.name = "CloudConfigError";
  }
}

function normalizeOrigin(variable: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new CloudConfigError(variable, value);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CloudConfigError(variable, value);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CloudConfigError(variable, value);
  }
  // Credentials in the URL would travel in the `Origin` header and in every request line.
  if (url.username.length > 0 || url.password.length > 0)
    throw new CloudConfigError(variable, value);
  return url.origin;
}

/**
 * The cloud configuration for this run. Throws rather than falling back to a default when an override
 * is present but malformed: a typo that silently pointed the app at production would be worse than a
 * refusal to start.
 */
export function resolveCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  return {
    apiOrigin: normalizeOrigin(API_ORIGIN_ENV, env[API_ORIGIN_ENV] ?? DEFAULT_API_ORIGIN),
    webOrigin: normalizeOrigin(WEB_ORIGIN_ENV, env[WEB_ORIGIN_ENV] ?? DEFAULT_WEB_ORIGIN),
  };
}
