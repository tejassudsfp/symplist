/**
 * The `mcpServers` entry a dsh ACP session mounts Symplist's tools with.
 *
 * Pure, and separate from the relay, because two properties of it are easy to break by accident and
 * cheap to assert:
 *
 *   1. **No credential crosses stdio.** The entry carries a loopback URL and a per-launch capability
 *      token — nothing that survives a restart, nothing that works from another machine. The `sym_…`
 *      bearer is added by the relay, inside this process, one hop later. `assertNoBearer` below is not
 *      decoration: the tempting "simplification" is to put the key in these headers and delete the relay,
 *      and that would hand a 30-day bearer for the whole task surface to a process running a shell.
 *   2. **The server name survives normalization.** `dsh-acp`'s `normalizeServerName` hashes any name
 *      outside `[A-Za-z0-9_-]{1,32}`, and `dsh-mcp-client`'s `publicToolName` appends a 12-hex hash when
 *      `mcp__<server>__<tool>` exceeds 64 characters or contains anything else. Either would turn
 *      `mcp__symplist__task_document_update_section` into something unreadable in the UI and in
 *      permission rules. `symplist` plus the longest tool name is 43 characters, so both stay clean — and
 *      `toolNameIsClean` keeps it that way if a longer tool name is ever added.
 *
 * The same entry is passed to `session/new` and to `session/resume`, because resume re-mounts MCP configs
 * from scratch rather than restoring the old ones; a resume built from a stale port would produce a
 * session whose tools all fail.
 */
import { relayCapabilityHeader } from "./policy.ts";

/** ACP's `McpServerHttp`: the exact shape `resolveMcpConfigs` accepts for a `streamable-http` mount. */
export interface AcpHttpMcpServer {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}

/**
 * The tool namespace. Short on purpose: it prefixes every tool name the model sees, and a longer one
 * would spend the 64-character budget that keeps those names readable.
 */
export const symplistServerName = "symplist";

/** `normalizeServerName`'s clean case, so a rename cannot silently start hashing the namespace. */
const validServerName = /^[A-Za-z0-9_-]{1,32}$/;

/** `publicToolName`'s clean case: the model-facing name must be verbatim and within 64 characters. */
export function toolNameIsClean(toolName: string, serverName = symplistServerName): boolean {
  const publicName = `mcp__${serverName}__${toolName}`;
  return publicName.length <= 64 && /^[A-Za-z0-9_-]+$/.test(publicName);
}

/**
 * The 17 tools the cloud's `/mcp` endpoint serves. Listed here only so `toolNameIsClean` can be asserted
 * over all of them: the relay forwards whatever `tools/list` returns and this list is never used to filter.
 */
export const symplistToolNames = Object.freeze([
  "artifact_share_list",
  "artifact_share_revoke",
  "artifact_snapshot",
  "task_context",
  "task_create",
  "task_document_changes",
  "task_document_diff",
  "task_document_history",
  "task_document_outline",
  "task_document_read_section",
  "task_document_restore",
  "task_document_search",
  "task_document_update_section",
  "task_list",
  "task_move",
  "task_schedule",
  "task_search",
] as const);

export function symplistMcpServer(relay: {
  readonly url: string;
  readonly capability: string;
}): AcpHttpMcpServer {
  const entry: AcpHttpMcpServer = {
    type: "http",
    name: symplistServerName,
    url: relay.url,
    headers: [{ name: relayCapabilityHeader, value: relay.capability }],
  };
  assertNoBearer(entry);
  if (!validServerName.test(entry.name)) {
    throw new Error("symplist mcp: the server name would be normalized, hashing every tool name");
  }
  return entry;
}

/**
 * Refuses an entry carrying anything that looks like a Symplist grant key or an Authorization header.
 * It runs on every construction rather than in a test alone, because the mistake it catches would still
 * work perfectly — the agent's tools would keep functioning while the credential sat next to its shell.
 */
export function assertNoBearer(entry: AcpHttpMcpServer): void {
  for (const header of entry.headers) {
    if (header.name.toLowerCase() === "authorization") {
      throw new Error("symplist mcp: an ACP payload must not carry an Authorization header");
    }
    if (header.value.startsWith("sym_")) {
      throw new Error("symplist mcp: an ACP payload must not carry a Symplist grant key");
    }
  }
  if (!entry.url.startsWith("http://127.0.0.1:")) {
    throw new Error("symplist mcp: the ACP payload must point at the loopback relay");
  }
}
