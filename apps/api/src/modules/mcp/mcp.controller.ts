import {
  mcpAuthMetadataRouter,
  originValidation,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type OAuthMetadata } from "@modelcontextprotocol/server";
import { All, Controller, Get, Inject, Req, Res } from "@nestjs/common";
import type { McpIdentity } from "@symplist/core/mcp";
import type { Request, RequestHandler, Response } from "express";
import { ApiError } from "../../common/errors/api-error.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { IpFailureLimiter } from "../../infra/limits/ip-failures.ts";
import { MCP_TOOLS, type McpTools } from "./mcp-tools.ts";
import { OAUTH_RUNTIME, type OAuthRuntime } from "./oauth.runtime.ts";

/** Run framework middleware after Nest's host/origin/cookie guards, respecting terminal responses. */
function middleware(
  handler: RequestHandler,
  request: Request,
  response: Response,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      response.off("finish", done);
      response.off("close", done);
    };
    response.once("finish", done);
    response.once("close", done);
    try {
      Promise.resolve(
        handler(request, response, (error?: unknown) => {
          cleanup();
          if (error) reject(error);
          else resolve(true);
        }),
      ).catch((error: unknown) => {
        cleanup();
        reject(error);
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function oauthMetadata(issuer: string): OAuthMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ["tasks:read", "tasks:write", "ai:run", "offline_access"],
  };
}

@Controller()
export class McpController {
  private readonly origin: RequestHandler;
  private readonly node: ReturnType<typeof toNodeHandler>;
  private readonly metadata: RequestHandler;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(OAUTH_RUNTIME) private readonly runtime: OAuthRuntime,
    @Inject(MCP_TOOLS) tools: McpTools,
    private readonly failures: IpFailureLimiter,
  ) {
    this.origin = originValidation([new URL(config.WEB_ORIGIN).hostname]);
    this.node = toNodeHandler(
      createMcpHandler(({ authInfo }) => {
        const identity = authInfo?.extra?.identity as McpIdentity | undefined;
        if (!identity) throw new Error("mcp.invalid_token");
        return tools.server(identity);
      }),
    );
    this.metadata = mcpAuthMetadataRouter({
      oauthMetadata: oauthMetadata(config.API_ORIGIN),
      resourceServerUrl: new URL(`${config.API_ORIGIN}/mcp`),
      scopesSupported: ["tasks:read", "tasks:write", "ai:run"],
      resourceName: "Symplist",
    });
  }

  @All("mcp")
  @RouteClass("mcp")
  async handle(@Req() request: Request, @Res() response: Response) {
    if (!(await middleware(this.origin, request, response))) return;
    this.failures.assertAllowed("mcp_invalid_credentials", request);
    const auth = requireBearerAuth({
      resourceMetadataUrl: `${this.config.API_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
      verifier: {
        verifyAccessToken: async (token) => {
          try {
            return await this.runtime.accessTokens.verifyAccessToken(token);
          } catch (error) {
            this.failures.recordFailure("mcp_invalid_credentials", request);
            throw error;
          }
        },
      },
    });
    if (!(await middleware(auth, request, response))) return;
    await this.node(request, response, request.body);
  }

  @Get([".well-known/oauth-protected-resource/mcp", ".well-known/oauth-authorization-server"])
  @RouteClass("public_read")
  async discovery(@Req() request: Request, @Res() response: Response) {
    if (await middleware(this.metadata, request, response)) throw new ApiError("not_found");
  }
}
