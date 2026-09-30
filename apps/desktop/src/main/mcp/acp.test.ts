// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertNoBearer,
  symplistMcpServer,
  symplistServerName,
  symplistToolNames,
  toolNameIsClean,
} from "./acp.ts";
import { relayCapabilityHeader } from "./policy.ts";

const relay = { url: "http://127.0.0.1:52345/mcp", capability: "cap".repeat(10) };

describe("the ACP mcpServers entry", () => {
  it("is the exact McpServerHttp shape dsh-acp accepts", () => {
    expect(symplistMcpServer(relay)).toEqual({
      type: "http",
      name: "symplist",
      url: relay.url,
      headers: [{ name: relayCapabilityHeader, value: relay.capability }],
    });
  });

  /*
   * The whole reason the relay exists. `session/new` crosses stdio in plaintext into a process that has
   * been handed a shell, so what it may carry is a loopback URL and a token that dies with the launch —
   * never the 30-day bearer. This assertion is in the construction path, not only here, because the
   * mistake it catches would keep working: the agent's tools would function while the credential sat next
   * to its shell.
   */
  it("refuses to carry a credential to the harness", () => {
    expect(() =>
      assertNoBearer({
        type: "http",
        name: "symplist",
        url: relay.url,
        headers: [{ name: "Authorization", value: "Bearer sym_x" }],
      }),
    ).toThrow(/Authorization/);
    expect(() =>
      assertNoBearer({
        type: "http",
        name: "symplist",
        url: relay.url,
        headers: [{ name: "X-Key", value: "sym_0198a1b2_abc" }],
      }),
    ).toThrow(/grant key/);
    expect(() =>
      assertNoBearer({
        type: "http",
        name: "symplist",
        url: "https://api.symplist.app/mcp",
        headers: [],
      }),
    ).toThrow(/loopback/);
  });

  /**
   * `normalizeServerName` in `dsh-acp` hashes any name outside `[A-Za-z0-9_-]{1,32}`, and
   * `publicToolName` in `dsh-mcp-client` appends a 12-hex hash when `mcp__<server>__<tool>` exceeds 64
   * characters. Either would make every tool unreadable in the UI and in permission rules, so the margin
   * is asserted over the whole tool set rather than assumed.
   */
  it("keeps every tool's model-facing name verbatim", () => {
    expect(symplistServerName).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    for (const tool of symplistToolNames) expect(toolNameIsClean(tool), tool).toBe(true);
    const longest = [...symplistToolNames].sort((a, b) => b.length - a.length)[0] ?? "";
    expect(`mcp__${symplistServerName}__${longest}`).toBe(
      "mcp__symplist__task_document_update_section",
    );
    // The margin that remains before a new tool name starts getting hashed.
    expect(64 - `mcp__${symplistServerName}__${longest}`.length).toBeGreaterThanOrEqual(20);
    expect(toolNameIsClean("task_document_update_section_with_a_very_long_suffix")).toBe(false);
  });
});
