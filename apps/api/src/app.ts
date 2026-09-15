import "reflect-metadata";
import type { NestApplicationOptions } from "@nestjs/common";
import { type IEntryNestModule, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.ts";

/** Routes served without the `/v1` prefix (§6), in path-to-regexp v8 syntax. */
export const unprefixedRoutes = [
  "mcp",
  "oauth{/*path}",
  ".well-known{/*path}",
  "artifact{/*path}",
  "webhooks{/*path}",
  "internal{/*path}",
  "healthz",
] as const;

/** Creates the Nest application with the bootstrap order from §6, without listening. */
export async function createApp(
  rootModule: IEntryNestModule = AppModule,
  options: Pick<NestApplicationOptions, "logger"> = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, {
    ...options,
    rawBody: true,
  });
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix("v1", { exclude: [...unprefixedRoutes] });
  app.enableShutdownHooks();
  return app;
}
