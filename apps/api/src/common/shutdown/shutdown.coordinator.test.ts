import { Controller, Get, Module } from "@nestjs/common";
import type { ManagedKeyProvider } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { describe, expect, it, vi } from "vitest";
import { bootTestApp } from "../../../test/harness.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { API_DATABASE, type ApiDatabase } from "../../infra/db/db.providers.ts";
import { RouteClass } from "../route-classes.ts";
import { REALTIME_SHUTDOWN, type RealtimeShutdown } from "../seams.ts";
import { SOCKET_CLOSE_TIMEOUT_MS } from "./shutdown.coordinator.ts";

const order: string[] = [];
let releaseRequest: (() => void) | undefined;
let requestEntered: (() => void) | undefined;

@Controller()
class SlowController {
  @Get(".well-known/slow")
  @RouteClass("public_read")
  async slow() {
    requestEntered?.();
    await new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    order.push("request_finished");
    return { ok: true };
  }
}

@Module({ controllers: [SlowController] })
class SlowModule {}

describe("graceful shutdown ordering (§5.5, §7)", () => {
  it("stops relays, closes sockets with 1001, drains HTTP, then closes infrastructure", async () => {
    const realtime: RealtimeShutdown = {
      stopRelays: vi.fn(async () => {
        order.push("relays_stopped");
      }),
      closeAllSockets: vi.fn(async (code: number, timeoutMs: number) => {
        order.push(`sockets_closed:${code}:${timeoutMs}`);
        releaseRequest?.();
      }),
    };
    const app = await bootTestApp({
      imports: [SlowModule],
      providers: [{ provide: REALTIME_SHUTDOWN, useValue: realtime }],
    });
    const database = app.inject<ApiDatabase>(API_DATABASE);
    const closeDatabase = database.close;
    const close = vi.spyOn(database, "close").mockImplementation(() => {
      order.push("database_closed");
      closeDatabase();
    });
    const keys = app.inject<ManagedKeyProvider>(KEY_PROVIDER);

    const entered = new Promise<void>((resolve) => {
      requestEntered = resolve;
    });
    const inFlight = fetch(`${app.baseUrl}/.well-known/slow`);
    await entered;
    await app.close();
    const response = await inFlight;

    expect(response.status).toBe(200);
    expect(order).toEqual([
      "relays_stopped",
      `sockets_closed:1001:${SOCKET_CLOSE_TIMEOUT_MS}`,
      "request_finished",
      "database_closed",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    // The key provider zeroized its keys last.
    expect(() => keys.families()).toThrow(/destroyed/);
    await expect(app.db.batch([sql("SELECT 1")])).rejects.toMatchObject({ code: "db.unavailable" });
  });
});
