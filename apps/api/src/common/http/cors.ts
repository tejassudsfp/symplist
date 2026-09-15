import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface.js";
import type { ApiConfig } from "@symplist/config/api";
import {
  csrfHeader,
  idempotencyKeyHeader,
  requestIdHeader,
  retryAfterHeader,
} from "@symplist/contracts";
import type { Request } from "express";
import { isShareHost } from "./host-surface.ts";

/** Credentialed CORS for the web app on `/v1/*` (§5.3, §6). */
export function appCorsOptions(config: Pick<ApiConfig, "WEB_ORIGIN">): CorsOptions {
  return {
    origin: [config.WEB_ORIGIN],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", csrfHeader, idempotencyKeyHeader],
    exposedHeaders: [retryAfterHeader, requestIdHeader],
    maxAge: 600,
  };
}

/**
 * The CORS delegate: `/v1/*` on the api host gets credentialed CORS for `WEB_ORIGIN` only; every other
 * path, and every share-host request, gets no CORS headers at all (§5.3).
 */
export function corsDelegate(
  config: Pick<ApiConfig, "WEB_ORIGIN" | "ARTIFACT_ORIGIN">,
): CorsOptionsDelegate<Request> {
  const app = appCorsOptions(config);
  return (req, callback) => {
    const path = req.path;
    const appPath = path === "/v1" || path.startsWith("/v1/");
    callback(null, appPath && !isShareHost(req, config) ? app : { origin: false });
  };
}
