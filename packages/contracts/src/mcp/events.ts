import { defineEvents } from "../common/ws.ts";

/**
 * WebSocket events owned by the agent-access feature (§14, §7), keyed by event type.
 *
 * Empty, and correctly so. The one event here was `connection.status_changed`, pushed when a Composio
 * account finished its hosted authorization — and connectors left with the server-side agent (note 18).
 * A grant being minted or revoked is the owner's own action in the tab they are looking at, so there is
 * nothing to tell them about from elsewhere.
 */
export const mcpEvents = defineEvents({});
