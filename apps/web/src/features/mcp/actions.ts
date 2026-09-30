import type { AppAction } from "@/actions/types";

/**
 * Actions contributed by the agent-access feature to the command registry (§10.2).
 *
 * One, where there were two. "Service connections" opened the Composio connector screen, and those
 * left with the server-side agent (note 18) — the assistant is now whichever MCP client the person
 * already uses, and it brings its own connectors.
 */
export const mcpActions: readonly AppAction[] = [
  {
    id: "connections.agents",
    label: "Agent connections",
    context: "app",
    group: "navigation",
    keywords: ["MCP", "API keys", "revoke", "assistant", "Claude"],
    availability: () => ({ enabled: true }),
    run: ({ services }) => services.navigate("/settings/agents"),
  },
];
