import { accessErrorCodes } from "./access/errors.ts";
import { analyticsErrorCodes } from "./analytics/errors.ts";
import { commonErrorCodes, type ErrorHttpStatus } from "./common/errors.ts";
import { connectionsErrorCodes } from "./connections/errors.ts";
import { documentsErrorCodes } from "./documents/errors.ts";
import { schedulingErrorCodes } from "./scheduling/errors.ts";
import { searchErrorCodes } from "./search/errors.ts";
import { sharingErrorCodes } from "./sharing/errors.ts";
import { simonErrorCodes } from "./simon/errors.ts";
import { vaultErrorCodes } from "./vault/errors.ts";
import { workspaceErrorCodes } from "./workspace/errors.ts";

/** Error-code maps by owner, so tests can prove that no two owners declare the same code. */
export const errorCodesByOwner = {
  common: commonErrorCodes,
  access: accessErrorCodes,
  workspace: workspaceErrorCodes,
  documents: documentsErrorCodes,
  search: searchErrorCodes,
  simon: simonErrorCodes,
  scheduling: schedulingErrorCodes,
  vault: vaultErrorCodes,
  sharing: sharingErrorCodes,
  connections: connectionsErrorCodes,
  analytics: analyticsErrorCodes,
} as const;

/** Every stable error code mapped to its HTTP status (§6). */
export const errorCodes = Object.freeze({
  ...commonErrorCodes,
  ...accessErrorCodes,
  ...workspaceErrorCodes,
  ...documentsErrorCodes,
  ...searchErrorCodes,
  ...simonErrorCodes,
  ...schedulingErrorCodes,
  ...vaultErrorCodes,
  ...sharingErrorCodes,
  ...connectionsErrorCodes,
  ...analyticsErrorCodes,
});

export type ErrorCode = keyof typeof errorCodes;

/** Whether a string is one of the declared error codes. */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(errorCodes, value);
}

/** The HTTP status a declared error code is returned with. */
export function errorHttpStatus(code: ErrorCode): ErrorHttpStatus {
  return errorCodes[code];
}
