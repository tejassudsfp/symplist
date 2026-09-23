import type { ConfigIssue } from "./errors.ts";

/**
 * The secret inventory (§4.5): the single list of generated secret families and provider
 * credentials, and which runtime may hold each. Browser-safe and dependency-free, so
 * `scripts/secrets-generate.mjs` can import it directly with Node's type stripping.
 */

/**
 * Generated secret families (§4.5). Each is configured as `<NAME>_<n>` (32 random bytes, base64url)
 * plus `<NAME>_CURRENT=<n>`, and every stored digest, wrap and JWT `kid` records its version.
 */
export const generatedSecretFamilies = [
  "CONTENT_KEK",
  "INTERNAL_EVENT_SECRET",
  "REMINDER_UNSUBSCRIBE_SECRET",
  "VAULT_RECOVERY_KEY",
  "SESSION_DIGEST_SECRET",
  "OTP_DIGEST_SECRET",
  "INVITE_DIGEST_SECRET",
  "SHARE_DIGEST_SECRET",
  "SHARE_SESSION_DIGEST_SECRET",
  "MCP_TOKEN_DIGEST_SECRET",
  "MCP_OAUTH_SIGNING_KEY",
  "IDEMPOTENCY_SECRET",
] as const;

export type GeneratedSecretFamily = (typeof generatedSecretFamilies)[number];

/** The runtimes that hold configuration secrets. */
export type SecretRuntime = "api" | "worker";

/**
 * How a runtime treats a secret (§4.5 table): `yes` holds it, `rejected` refuses to start when it
 * is set, `no` never uses it (also refused at startup), and `platform_injected` accepts the value
 * Trigger.dev injects but never syncs it.
 *
 * There was a fifth, `durable_false_only`, which held a secret only under `DURABLE=false`. Model
 * credentials were the only thing it ever described: the api was allowed `OPENAI_API_KEY` when it
 * ran the loop in process and refused it when Trigger did, so that a durable api could not run
 * model code even by accident. Bringing your own key retires the placement rather than weakens it —
 * those variables are now `rejected` on both runtimes, because no deployment holds a model
 * credential at all, and the guarantee that the durable api cannot call a provider no longer
 * depends on a conditional.
 */
export type SecretHolding = "yes" | "rejected" | "no" | "platform_injected";

export interface SecretInventoryEntry {
  readonly api: SecretHolding;
  readonly worker: SecretHolding;
  /** Whether GitHub Actions holds it. */
  readonly ci: boolean;
}

/** Generated secret families by runtime (§4.5). */
export const secretFamilyInventory = {
  CONTENT_KEK: { api: "yes", worker: "yes", ci: false },
  INTERNAL_EVENT_SECRET: { api: "yes", worker: "yes", ci: false },
  REMINDER_UNSUBSCRIBE_SECRET: { api: "yes", worker: "yes", ci: false },
  VAULT_RECOVERY_KEY: { api: "yes", worker: "rejected", ci: false },
  SESSION_DIGEST_SECRET: { api: "yes", worker: "rejected", ci: false },
  OTP_DIGEST_SECRET: { api: "yes", worker: "rejected", ci: false },
  INVITE_DIGEST_SECRET: { api: "yes", worker: "rejected", ci: false },
  SHARE_DIGEST_SECRET: { api: "yes", worker: "rejected", ci: false },
  SHARE_SESSION_DIGEST_SECRET: { api: "yes", worker: "rejected", ci: false },
  MCP_TOKEN_DIGEST_SECRET: { api: "yes", worker: "rejected", ci: false },
  MCP_OAUTH_SIGNING_KEY: { api: "yes", worker: "rejected", ci: false },
  IDEMPOTENCY_SECRET: { api: "yes", worker: "rejected", ci: false },
} as const satisfies Readonly<Record<GeneratedSecretFamily, SecretInventoryEntry>>;

/** Provider-issued credentials (single values) by runtime (§4.5). */
export const providerCredentialInventory = {
  CLOUDFLARE_D1_API_TOKEN: { api: "yes", worker: "rejected", ci: false },
  CLOUDFLARE_D1_WORKER_API_TOKEN: { api: "rejected", worker: "yes", ci: false },
  CLOUDFLARE_D1_MIGRATE_API_TOKEN: { api: "rejected", worker: "rejected", ci: true },
  R2_ACCESS_KEY_ID: { api: "yes", worker: "yes", ci: false },
  R2_SECRET_ACCESS_KEY: { api: "yes", worker: "yes", ci: false },
  COMPOSIO_API_KEY: { api: "yes", worker: "yes", ci: false },
  RESEND_API_KEY: { api: "yes", worker: "yes", ci: false },
  POSTHOG_PROJECT_KEY: { api: "yes", worker: "yes", ci: false },
  /**
   * Model credentials are the account's, not the deployment's (§8.6), so no runtime may hold one.
   *
   * These stay listed as rejected rather than being dropped from the inventory: a deployment
   * upgrading from server-paid models has these in its environment already, and failing to boot
   * with a named variable is how its operator finds out that keys moved into each account's
   * settings. Silently ignoring a set `OPENAI_API_KEY` would leave them believing it was still
   * being used.
   */
  OPENAI_API_KEY: { api: "rejected", worker: "rejected", ci: false },
  ANTHROPIC_API_KEY: { api: "rejected", worker: "rejected", ci: false },
  AWS_ACCESS_KEY_ID: { api: "rejected", worker: "rejected", ci: false },
  AWS_SECRET_ACCESS_KEY: { api: "rejected", worker: "rejected", ci: false },
  GOOGLE_VERTEX_CREDENTIALS_JSON: { api: "rejected", worker: "rejected", ci: false },
  TOGETHER_API_KEY: { api: "rejected", worker: "rejected", ci: false },
  RESEND_WEBHOOK_SECRET: { api: "yes", worker: "rejected", ci: false },
  COMPOSIO_WEBHOOK_SECRET: { api: "yes", worker: "rejected", ci: false },
  POSTHOG_PERSONAL_API_KEY: { api: "yes", worker: "rejected", ci: false },
  TRIGGER_SECRET_KEY: { api: "yes", worker: "platform_injected", ci: false },
  TRIGGER_ACCESS_TOKEN: { api: "no", worker: "no", ci: true },
} as const satisfies Readonly<Record<string, SecretInventoryEntry>>;

export type ProviderCredential = keyof typeof providerCredentialInventory;

export const providerCredentials = Object.keys(providerCredentialInventory) as ProviderCredential[];

/** The generated families a runtime holds. */
export function secretFamiliesFor(runtime: SecretRuntime): GeneratedSecretFamily[] {
  return generatedSecretFamilies.filter(
    (family) => secretFamilyInventory[family][runtime] === "yes",
  );
}

/** Whether a variable name is a secret: a member of a generated family or a provider credential. */
export function isSecretVariable(name: string): boolean {
  return (
    Object.hasOwn(providerCredentialInventory, name) ||
    generatedSecretFamilies.some((family) => name === family || name.startsWith(`${family}_`))
  );
}

/**
 * Variables the worker refuses at startup (§4.5), written as patterns so unversioned and future
 * versions are caught too: `VAULT_RECOVERY_KEY_*`, `*_DIGEST_SECRET_*`, `MCP_OAUTH_SIGNING_KEY_*`,
 * `IDEMPOTENCY_SECRET_*`, the webhook secrets, `POSTHOG_PERSONAL_API_KEY` and
 * `CLOUDFLARE_D1_API_TOKEN`. The inventory adds `CLOUDFLARE_D1_MIGRATE_API_TOKEN` and
 * `TRIGGER_ACCESS_TOKEN`.
 */
export const workerRejectedVariablePatterns: readonly RegExp[] = [
  /^VAULT_RECOVERY_KEY(?:_.*)?$/,
  /^[A-Z0-9_]*_DIGEST_SECRET(?:_.*)?$/,
  /^MCP_OAUTH_SIGNING_KEY(?:_.*)?$/,
  /^IDEMPOTENCY_SECRET(?:_.*)?$/,
  /^RESEND_WEBHOOK_SECRET$/,
  /^COMPOSIO_WEBHOOK_SECRET$/,
  /^POSTHOG_PERSONAL_API_KEY$/,
  /^CLOUDFLARE_D1_API_TOKEN$/,
];

/** Variables that used to pay for models deployment-wide, kept only to be refused with a reason. */
const retiredModelCredentials: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GOOGLE_VERTEX_CREDENTIALS_JSON",
  "TOGETHER_API_KEY",
]);

function rejectionMessage(runtime: SecretRuntime, holding: SecretHolding, name: string): string {
  // Generic placement wording would send an operator looking for the runtime that does hold this.
  // None does: it says where the key went instead.
  if (retiredModelCredentials.has(name)) {
    return "must not be set: each account now adds its own provider key in Settings, and no deployment holds one";
  }
  if (holding === "no") {
    return `must not be set on the ${runtime}: only CI uses it`;
  }
  return runtime === "worker"
    ? "must not be set on the worker: it is an api-only secret"
    : "must not be set on the api: it belongs to another runtime";
}

/**
 * Issues for every variable the runtime must not hold (§4.5, §16.1).
 *
 * This used to take `{ durable }`, because whether the api could hold a model credential depended
 * on which executor ran the loop. No placement is conditional now that keys belong to accounts, so
 * the answer is the same in both modes and the argument would only suggest otherwise.
 */
export function rejectedSecretIssues(
  variables: Readonly<Record<string, string>>,
  runtime: SecretRuntime,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const name of Object.keys(variables)) {
    const credential = Object.hasOwn(providerCredentialInventory, name)
      ? providerCredentialInventory[name as ProviderCredential]
      : undefined;
    if (credential) {
      const holding = credential[runtime];
      if (holding === "rejected" || holding === "no") {
        issues.push({ variable: name, message: rejectionMessage(runtime, holding, name) });
        continue;
      }
    }
    const family = generatedSecretFamilies.find(
      (candidate) => name === candidate || name.startsWith(`${candidate}_`),
    );
    if (family && secretFamilyInventory[family][runtime] === "rejected") {
      issues.push({ variable: name, message: rejectionMessage(runtime, "rejected", name) });
      continue;
    }
    if (
      runtime === "worker" &&
      workerRejectedVariablePatterns.some((pattern) => pattern.test(name))
    ) {
      issues.push({ variable: name, message: rejectionMessage(runtime, "rejected", name) });
    }
  }
  return issues;
}

/** Bytes of entropy in every generated secret. */
export const generatedSecretBytes = 32;

/** Characters in a generated secret: 32 bytes as unpadded base64url. */
export const generatedSecretLength = 43;

const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decodes a generated secret: exactly 43 base64url characters without padding that decode to 32
 * bytes and re-encode to the same text (the two trailing bits must be zero). Returns null
 * otherwise. Lenient decoders accept far more (`"not a key!!"` decodes to 5 bytes), so length and
 * round-trip are both checked.
 */
export function decodeGeneratedSecret(value: string): Uint8Array | null {
  if (value.length !== generatedSecretLength) return null;
  const bytes = new Uint8Array(generatedSecretBytes);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let position = 0; position < value.length; position += 1) {
    const sextet = base64UrlAlphabet.indexOf(value.charAt(position));
    if (sextet < 0) return null;
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
    buffer &= (1 << bits) - 1;
  }
  return index === generatedSecretBytes && buffer === 0 ? bytes : null;
}

/** A parsed family: the version in use and every configured version's base64url value. */
export interface ParsedSecretFamily {
  readonly current: number;
  readonly versions: ReadonlyMap<number, string>;
}

const versionPattern = /^[1-9][0-9]{0,8}$/;

/**
 * Parses the given families from the present variables. Every family is required: it needs at least
 * one valid `<NAME>_<n>` and a `<NAME>_CURRENT` naming a configured version.
 */
export function parseSecretFamilies(
  variables: Readonly<Record<string, string>>,
  families: readonly GeneratedSecretFamily[],
): {
  readonly families: Partial<Record<GeneratedSecretFamily, ParsedSecretFamily>>;
  readonly issues: ConfigIssue[];
} {
  const parsed: Partial<Record<GeneratedSecretFamily, ParsedSecretFamily>> = {};
  const issues: ConfigIssue[] = [];
  for (const family of families) {
    const prefix = `${family}_`;
    const currentName = `${family}_CURRENT`;
    const versions = new Map<number, string>();
    const familyIssues: ConfigIssue[] = [];
    for (const [name, value] of Object.entries(variables)) {
      if (name === family) {
        familyIssues.push({
          variable: name,
          message: `must be configured as ${family}_<n> with ${currentName}=<n>`,
        });
        continue;
      }
      if (!name.startsWith(prefix) || name === currentName) continue;
      const suffix = name.slice(prefix.length);
      if (!versionPattern.test(suffix)) {
        familyIssues.push({
          variable: name,
          message: `is not a valid version name: use ${family}_<n> with n a positive whole number`,
        });
        continue;
      }
      if (decodeGeneratedSecret(value) === null) {
        familyIssues.push({
          variable: name,
          message:
            "must be 32 random bytes encoded as base64url (43 characters, no padding); generate one with pnpm secrets:generate",
        });
        continue;
      }
      versions.set(Number(suffix), value);
    }
    const current = variables[currentName];
    if (current === undefined) {
      familyIssues.push({
        variable: currentName,
        message: `is required: configure ${family}_<n> and ${currentName}=<n> (pnpm secrets:generate prints both)`,
      });
    } else if (!versionPattern.test(current)) {
      familyIssues.push({
        variable: currentName,
        message: "must be a positive whole number naming a configured version",
      });
    } else if (!versions.has(Number(current)) && variables[`${prefix}${current}`] === undefined) {
      familyIssues.push({
        variable: currentName,
        message: "names a version that is not configured",
      });
    }
    if (familyIssues.length === 0 && current !== undefined) {
      parsed[family] = Object.freeze({ current: Number(current), versions });
    }
    issues.push(...familyIssues);
  }
  return { families: parsed, issues };
}

/**
 * Issues for secret values that repeat (§4.5): the second and later variables sharing a value each
 * name the first one, never the value. Entries are compared in name order.
 */
export function duplicateSecretIssues(
  entries: Iterable<readonly [variable: string, value: string]>,
): ConfigIssue[] {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const firstByValue = new Map<string, string>();
  const issues: ConfigIssue[] = [];
  for (const [variable, value] of sorted) {
    const first = firstByValue.get(value);
    if (first === undefined) {
      firstByValue.set(value, variable);
    } else {
      issues.push({ variable, message: `must not reuse the value of ${first}` });
    }
  }
  return issues;
}

/** Every secret variable present in an environment, for the duplicate-value check. */
export function presentSecretEntries(
  variables: Readonly<Record<string, string>>,
): Array<readonly [string, string]> {
  return Object.entries(variables).filter(
    ([name]) => isSecretVariable(name) && !name.endsWith("_CURRENT"),
  );
}
