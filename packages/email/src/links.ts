import { EmailConfigurationError, EmailValidationError } from "./errors.ts";

/**
 * Configured link destinations for email templates (§12.3, §11.2). Every URL in an email is built
 * from this configuration or checked against it, so templates never embed secrets, Vault content
 * or action tokens. The one exception is the narrow reminder opt-out link, whose token can only
 * disable reminder email and which the caller passes in.
 */
export interface EmailLinkConfig {
  /** `WEB_ORIGIN`: authenticated app links (for example Open task) must stay on this origin. */
  readonly webOrigin: string;
  /** `API_ORIGIN`: the one-click reminder opt-out endpoint may live on this origin. */
  readonly apiOrigin: string;
  /** The configured account and help destination linked from the Vault reset notice. */
  readonly accountHelpUrl: string;
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUrl(value: string, label: string, toError: (message: string) => Error): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw toError(`${label} is not an absolute URL`);
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && loopbackHosts.has(url.hostname);
  if (!secure && !loopback) {
    throw toError(`${label} must use https (plain http is allowed only for loopback hosts)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw toError(`${label} must not carry credentials`);
  }
  if (url.hash !== "") {
    throw toError(`${label} must not carry a fragment`);
  }
  return url;
}

function parseOrigin(value: string, label: string): string {
  const url = parseUrl(value, label, configError);
  if (url.pathname !== "/" || url.search !== "") {
    throw configError(`${label} must be an origin without a path or query`);
  }
  return url.origin;
}

function configError(message: string): EmailConfigurationError {
  return new EmailConfigurationError("email.not_configured", message);
}

function inputError(message: string): EmailValidationError {
  return new EmailValidationError("email.invalid_template_input", message);
}

/** Validated link configuration with normalized origins. */
export interface ResolvedEmailLinks {
  readonly webOrigin: string;
  readonly apiOrigin: string;
  readonly accountHelpUrl: string;
}

/** Validates the configured origins and help destination once, at startup. */
export function resolveEmailLinks(config: EmailLinkConfig): ResolvedEmailLinks {
  const webOrigin = parseOrigin(config.webOrigin, "webOrigin");
  const apiOrigin = parseOrigin(config.apiOrigin, "apiOrigin");
  const help = parseUrl(config.accountHelpUrl, "accountHelpUrl", configError);
  if (help.search !== "") {
    throw configError("accountHelpUrl must not carry a query string");
  }
  return { webOrigin, apiOrigin, accountHelpUrl: help.href };
}

/**
 * An authenticated app link such as Open task: same origin as the web app, and no query string or
 * fragment, so it can never carry a token. Opening it requires sign-in and changes nothing.
 */
export function checkAppLink(value: string, links: ResolvedEmailLinks, label: string): string {
  const url = parseUrl(value, label, inputError);
  if (url.origin !== links.webOrigin) {
    throw inputError(`${label} must be on the configured web origin`);
  }
  if (url.search !== "") {
    throw inputError(`${label} must not carry a query string`);
  }
  return url.href;
}

/**
 * The reminder preferences or one-click opt-out link. It may carry the narrow
 * `reminder-unsubscribe` token in its query, and must be on the web or api origin.
 */
export function checkReminderPreferencesLink(
  value: string,
  links: ResolvedEmailLinks,
  label: string,
): string {
  const url = parseUrl(value, label, inputError);
  if (url.origin !== links.webOrigin && url.origin !== links.apiOrigin) {
    throw inputError(`${label} must be on the configured web or api origin`);
  }
  return url.href;
}
