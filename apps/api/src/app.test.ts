import { Controller, Get, Module } from "@nestjs/common";
import type { IEntryNestModule } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule } from "./app.module.ts";
import { createApp } from "./app.ts";
import { HealthController } from "./modules/system/health.controller.ts";
import { HealthService } from "./modules/system/health.service.ts";

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function listen(rootModule: IEntryNestModule = AppModule): Promise<string> {
  app = await createApp(rootModule, { logger: ["error", "warn"] });
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

describe("api bootstrap", () => {
  it("serves GET /healthz without the v1 prefix", async () => {
    const base = await listen();

    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await fetch(`${base}/v1/healthz`)).status).toBe(404);
  });

  it("prefixes feature routes with /v1 and leaves the excluded surfaces unprefixed", async () => {
    @Controller()
    class ProbeController {
      @Get("probe")
      probe() {
        return { ok: true };
      }

      @Get("webhooks/probe")
      webhook() {
        return { ok: true };
      }

      @Get(".well-known/probe")
      wellKnown() {
        return { ok: true };
      }
    }

    @Module({ controllers: [ProbeController] })
    class ProbeModule {}

    const base = await listen(ProbeModule);
    expect((await fetch(`${base}/v1/probe`)).status).toBe(200);
    expect((await fetch(`${base}/probe`)).status).toBe(404);
    expect((await fetch(`${base}/webhooks/probe`)).status).toBe(200);
    expect((await fetch(`${base}/v1/webhooks/probe`)).status).toBe(404);
    expect((await fetch(`${base}/.well-known/probe`)).status).toBe(200);
  });

  it("emits design:paramtypes metadata for injected providers under the Vitest transform", () => {
    expect(Reflect.getMetadata("design:paramtypes", HealthController)).toEqual([HealthService]);
  });
});
