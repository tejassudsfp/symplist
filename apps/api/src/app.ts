import "reflect-metadata";
import { type INestApplication, StandardSchemaValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ConfigError } from "@symplist/config";
import { loadApiConfig } from "@symplist/config/api";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { AppModule, type AppModuleOptions } from "./app.module.ts";
import { CLOCK, type Clock } from "./common/clock.ts";
import { ApiError, sendApiError } from "./common/errors/api-error.ts";
import { ApiExceptionFilter, toApiError } from "./common/errors/exception.filter.ts";
import { validationExceptionFactory } from "./common/errors/validation.ts";
import { bodyParsers, jsonBodyLimitBytes } from "./common/http/body-parsers.ts";
import { corsDelegate } from "./common/http/cors.ts";
import { globalPrefix, unprefixedRoutes } from "./common/http/global-prefix.ts";
import { hostSurfaceMiddleware } from "./common/http/host-surface.ts";
import { apiHelmetOptions } from "./common/http/security-headers.ts";
import { AppLogger, NestLoggerAdapter, stdoutLogSink } from "./common/logging/logger.ts";
import {
  matchedRoute,
  requestContextMiddleware,
  requestStateOf,
} from "./common/request-context.ts";
import { API_CONFIG, type ApiConfig } from "./infra/config/api-config.ts";
import { AuthWsAdapter } from "./modules/realtime/auth-ws.adapter.ts";

export { globalPrefix, jsonBodyLimitBytes, unprefixedRoutes };

function requestLogMiddleware(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      const state = requestStateOf(req);
      if (!state) return;
      if (!state.route) state.route = matchedRoute(req);
      const durationMs = Math.round(performance.now() - state.startedAt);
      logger.write(res.statusCode >= 500 ? "error" : "info", "http.request", {
        method: req.method,
        status: res.statusCode,
        durationMs,
        routeClass: state.routeClass,
      });
    });
    next();
  };
}

/**
 * Applies the bootstrap order of §6, §7 and §10.4 to an application created with
 * `bodyParser: false`: trust proxy, helmet, request context and request logs, host routing, cookie
 * parsing, CORS for `/v1/*` only, the per-path body parsers (which keep the raw body), the Standard
 * Schema validation pipe, the error envelope filter, the `/v1` global prefix with its exclusions and
 * the authenticating WebSocket adapter, which must be installed before the gateway binds at init.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ApiConfig>(API_CONFIG);
  const clock = app.get<Clock>(CLOCK);
  const logger = app.get(AppLogger);
  app.useLogger(app.get(NestLoggerAdapter));
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.disable("x-powered-by");
  app.use(helmet(apiHelmetOptions));
  app.use(requestContextMiddleware(() => clock.now()));
  app.use(requestLogMiddleware(logger));
  app.use(hostSurfaceMiddleware(config));
  app.use(cookieParser());
  app.enableCors(corsDelegate(config));
  for (const parser of bodyParsers(config)) app.use(parser);
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({ exceptionFactory: validationExceptionFactory }),
  );
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.setGlobalPrefix(globalPrefix, { exclude: [...unprefixedRoutes] });
  app.useWebSocketAdapter(new AuthWsAdapter(app));
}

/**
 * Initializes a configured application and appends the fallbacks Express runs after every route:
 * unknown paths outside `/v1` and errors raised by middleware outside Nest's exception layer still
 * return the §6 envelope instead of Express's HTML pages.
 */
export async function initializeApp(app: NestExpressApplication): Promise<void> {
  await app.init();
  const logger = app.get(AppLogger);
  app.use((req: Request, res: Response) => {
    sendApiError(res, ApiError.notFound(), requestStateOf(req)?.requestId ?? "unknown");
  });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const apiError = toApiError(error);
    if (apiError.status >= 500 && apiError.code !== "rate.limited") {
      logger.error("http.unhandled_error", { error });
    }
    sendApiError(res, apiError, requestStateOf(req)?.requestId ?? "unknown");
  });
}

/** Creates, configures and initializes the application without listening. */
export async function createApp(options: AppModuleOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), {
    bodyParser: false,
    bufferLogs: true,
    abortOnError: false,
  });
  configureApp(app);
  await initializeApp(app);
  return app;
}

export interface StartOptions {
  /** Where configuration failures are written; defaults to standard error. */
  readonly stderr?: (text: string) => void;
}

/**
 * Starts the api from an environment: validates configuration first and fails fast, naming each
 * invalid variable without echoing its value (§16.1); then listens on `PORT` with shutdown hooks.
 * Returns null when configuration is invalid (the caller sets the exit code).
 */
export async function startApi(
  env: Readonly<Record<string, string | undefined>>,
  options: StartOptions = {},
): Promise<INestApplication | null> {
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let config: ApiConfig;
  try {
    config = loadApiConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr(`${error.message}\n`);
      return null;
    }
    throw error;
  }
  const app = await createApp({ config, logSink: stdoutLogSink });
  app.enableShutdownHooks();
  await app.listen(config.PORT, "0.0.0.0");
  return app;
}
