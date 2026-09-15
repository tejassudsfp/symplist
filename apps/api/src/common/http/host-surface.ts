import type { ApiConfig } from "@symplist/config/api";
import type { NextFunction, Request, Response } from "express";
import { ApiError, sendApiError } from "../errors/api-error.ts";
import { requestStateOf } from "../request-context.ts";

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a request is addressed to the share host (§6, §13.2). Hosts are compared by name: the
 * configuration guarantees `ARTIFACT_ORIGIN` uses a hostname different from the api and web origins.
 */
export function isShareHost(req: Request, config: Pick<ApiConfig, "ARTIFACT_ORIGIN">): boolean {
  return hostnameOf(req.headers.host) === new URL(config.ARTIFACT_ORIGIN).hostname.toLowerCase();
}

function isArtifactPath(path: string): boolean {
  return path === "/artifact" || path.startsWith("/artifact/");
}

/**
 * Host routing (§6): requests to the share host may reach only `/artifact/*`, and `/artifact/*` on
 * any other host returns 404. Api-host responses default to `Cache-Control: no-store`; share routes
 * set their own caching headers (§13.4).
 */
export function hostSurfaceMiddleware(config: Pick<ApiConfig, "ARTIFACT_ORIGIN">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const share = isShareHost(req, config);
    if (share !== isArtifactPath(req.path)) {
      sendApiError(res, ApiError.notFound(), requestStateOf(req)?.requestId ?? "unknown");
      return;
    }
    if (!share) res.setHeader("Cache-Control", "no-store");
    next();
  };
}
