import type { FeatureId } from "@symplist/contracts";
import { accessActions } from "@/features/access/actions";
import { analyticsActions } from "@/features/analytics/actions";
import { connectionsActions } from "@/features/connections/actions";
import { documentsActions } from "@/features/documents/actions";
import { schedulingActions } from "@/features/scheduling/actions";
import { searchActions } from "@/features/search/actions";
import { sharingActions } from "@/features/sharing/actions";
import { simonActions } from "@/features/simon/actions";
import { vaultActions } from "@/features/vault/actions";
import { workspaceActions } from "@/features/workspace/actions";
import type { AppAction } from "./types";

/** Each feature's actions, collected from `features/<feature>/actions.ts`. */
export const actionsByFeature: Readonly<Record<FeatureId, readonly AppAction[]>> = {
  access: accessActions,
  workspace: workspaceActions,
  documents: documentsActions,
  search: searchActions,
  simon: simonActions,
  scheduling: schedulingActions,
  vault: vaultActions,
  sharing: sharingActions,
  connections: connectionsActions,
  analytics: analyticsActions,
};

/** The single action registry used by buttons, menus, the palette and shortcuts (§10.2). */
export const actionRegistry: readonly AppAction[] = Object.values(actionsByFeature).flat();
