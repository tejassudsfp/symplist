import { createHash } from "node:crypto";
import type { ConnectionApprovalMode } from "@symplist/contracts";

/** A change to this policy is a reviewed deploy, never a model or provider decision (§8.5). */
export const APPROVAL_POLICY_VERSION = "2026-09-22.1";

export interface DiscoveredAction {
  readonly slug: string;
  readonly schema: unknown;
  readonly tags: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
  } | null;
}

export interface ReviewedReadAction {
  readonly slug: string;
  readonly schemaHash: string;
  /** Exact argument paths reviewed as selectors, not destinations or arbitrary prose. */
  readonly selectorPaths: readonly string[];
}

/**
 * No upstream action has been reviewed at deploy time. Provider tags alone still never authorize
 * execution: an exemption needs an entry here or the connection owner's own "reads" choice.
 */
export const REVIEWED_READ_ACTIONS: readonly ReviewedReadAction[] = Object.freeze([]);

export type ActionPolicy = "approval_required" | "exempt" | "unavailable";

const forbiddenSlugs = new Set([
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
]);

/** The discovered catalogue is trusted server state; a model cannot nominate a new slug. */
export function actionAvailable(slug: string, discovered: readonly DiscoveredAction[]): boolean {
  return (
    /^[A-Z][A-Z0-9_]{1,127}$/.test(slug) &&
    !forbiddenSlugs.has(slug) &&
    !slug.startsWith("COMPOSIO_") &&
    discovered.some((action) => action.slug === slug)
  );
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("policy.schema_invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("policy.schema_invalid");
  }
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v, depth + 1)}`)
    .join(",")}}`;
}

export function actionSchemaHash(schema: unknown): string {
  return createHash("sha256").update(canonical(schema)).digest("hex");
}

/** Whether one string argument, at its exact path, is an accepted selector rather than free input. */
type SelectorRule = (path: string, text: string) => boolean;

/**
 * The longest owner-waived selector. An id, a label, a filter or a search term fits well inside it;
 * a message, a document or a pasted instruction does not, and an owner who waived the ask for reads
 * did not waive it for prose a provider result could have planted.
 */
const OWNER_SELECTOR_MAX_LENGTH = 256;

/** An owner waives the ask for a whole connection, so the shape of the value carries the review. */
const ownerSelector: SelectorRule = (_path, text) =>
  text.length <= OWNER_SELECTOR_MAX_LENGTH && !/\p{Cc}/u.test(text);

function hasDestination(value: unknown, isSelector: SelectorRule, path = "", depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === "string") {
    // Even an accepted selector cannot smuggle a recipient or URL through its value.
    return /(?:[a-z][a-z\d+.-]*:\/\/|mailto:|www\.|@)/i.test(value) || !isSelector(path, value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasDestination(item, isSelector, `${path}[]`, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) return true;
    return Object.entries(value).some(([key, item]) => {
      const child = path ? `${path}.${key}` : key;
      return (
        /(?:url|uri|recipient|destination|email|address|body|message|text|prompt)/i.test(key) ||
        hasDestination(item, isSelector, child, depth + 1)
      );
    });
  }
  return (
    value !== null &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  );
}

export function actionPolicy(
  slug: string,
  argumentsValue: unknown,
  discovered: readonly DiscoveredAction[],
  reviewed: readonly ReviewedReadAction[] = REVIEWED_READ_ACTIONS,
  approvalMode: ConnectionApprovalMode = "all",
): ActionPolicy {
  if (!actionAvailable(slug, discovered)) return "unavailable";
  const action = discovered.find((entry) => entry.slug === slug);
  // The provider's own tags are the floor under every exemption. A write, a destructive action, or
  // an action that says nothing about itself, stays gated whatever the owner chose.
  if (action?.tags?.readOnlyHint !== true || action.tags.destructiveHint) {
    return "approval_required";
  }
  const review = reviewed.find((entry) => entry.slug === slug);
  if (!review && approvalMode !== "reads") return "approval_required";
  try {
    // An unhashable schema is an action we cannot reason about, and one that moved since its review
    // is a different action wearing the same slug.
    const hash = actionSchemaHash(action.schema);
    if (review && hash !== review.schemaHash) return "approval_required";
  } catch {
    return "approval_required";
  }
  // An owner who chose "reads" reviewed the connection rather than each argument path, so the
  // reviewed path list stops narrowing what counts as a selector. The value rules never relax.
  const isSelector: SelectorRule =
    approvalMode === "reads"
      ? ownerSelector
      : (path) => review?.selectorPaths.includes(path) === true;
  return hasDestination(argumentsValue, isSelector) ? "approval_required" : "exempt";
}

export interface ProposedAction {
  readonly slug: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** The preference of the connection this action would run on; absent is the strict default. */
  readonly approvalMode?: ConnectionApprovalMode;
}

/** Validate the whole batch before any effect: a gated action must be the only action (§8.4). */
export function executionBatchPolicy(
  actions: readonly ProposedAction[],
  discovered: readonly DiscoveredAction[],
  reviewed: readonly ReviewedReadAction[] = REVIEWED_READ_ACTIONS,
): ActionPolicy | "split_required" {
  if (actions.length === 0 || actions.length > 10) return "unavailable";
  const policies = actions.map((action) =>
    actionPolicy(action.slug, action.arguments, discovered, reviewed, action.approvalMode),
  );
  if (policies.includes("unavailable")) return "unavailable";
  if (policies.includes("approval_required")) {
    return actions.length === 1 ? "approval_required" : "split_required";
  }
  return "exempt";
}
