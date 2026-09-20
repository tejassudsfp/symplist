import type { AppAction } from "@/actions/types";

/** Actions contributed by the connections feature to the command registry (§10.2). */
export const connectionsActions: readonly AppAction[] = [
  {
    id: "connections.open",
    label: "Service connections",
    context: "app",
    group: "navigation",
    keywords: ["connect", "reconnect", "accounts"],
    availability: () => ({ enabled: true }),
    run: ({ services }) => services.navigate("/settings/connections"),
  },
  {
    id: "connections.agents",
    label: "Agent connections",
    context: "app",
    group: "navigation",
    keywords: ["MCP", "API keys", "revoke"],
    availability: () => ({ enabled: true }),
    run: ({ services }) => services.navigate("/settings/agents"),
  },
];
