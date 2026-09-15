import { accessTools } from "./access/tools.ts";
import { analyticsTools } from "./analytics/tools.ts";
import { connectionsTools } from "./connections/tools.ts";
import { documentsTools } from "./documents/tools.ts";
import { schedulingTools } from "./scheduling/tools.ts";
import { searchTools } from "./search/tools.ts";
import { sharingTools } from "./sharing/tools.ts";
import { simonTools } from "./simon/tools.ts";
import { vaultTools } from "./vault/tools.ts";
import { workspaceTools } from "./workspace/tools.ts";

/** Tool contracts by owning feature, so tests can prove tool names are unique. */
export const toolContractsByFeature = {
  access: accessTools,
  workspace: workspaceTools,
  documents: documentsTools,
  search: searchTools,
  simon: simonTools,
  scheduling: schedulingTools,
  vault: vaultTools,
  sharing: sharingTools,
  connections: connectionsTools,
  analytics: analyticsTools,
} as const;

/** Every Simon and MCP tool contract, keyed by tool name. */
export const toolContracts = Object.freeze({
  ...accessTools,
  ...workspaceTools,
  ...documentsTools,
  ...searchTools,
  ...simonTools,
  ...schedulingTools,
  ...vaultTools,
  ...sharingTools,
  ...connectionsTools,
  ...analyticsTools,
});

export type ToolName = keyof typeof toolContracts;
