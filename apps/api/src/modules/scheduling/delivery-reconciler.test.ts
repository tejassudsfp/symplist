import type { ResendDeliveryEvents } from "@symplist/core/scheduling";
import { describe, expect, it, vi } from "vitest";
import type { AppLogger } from "../../common/logging/logger.ts";
import type { ApiConfig } from "../../infra/config/api-config.ts";
import type { RuntimeTimers } from "../../infra/scheduler/runtime.ts";
import { DeliveryReconciler } from "./delivery-reconciler.ts";

function fixture(enabled: boolean, reconcile = vi.fn(async () => {})) {
  const setInterval = vi.fn(() => "timer");
  const clearInterval = vi.fn();
  const warn = vi.fn();
  const worker = new DeliveryReconciler(
    { RESEND_WEBHOOK_SECRET: enabled ? "configured" : undefined } as ApiConfig,
    { reconcile } as unknown as ResendDeliveryEvents,
    { setInterval, clearInterval } as unknown as RuntimeTimers,
    { warn } as unknown as AppLogger,
  );
  return { worker, reconcile, setInterval, clearInterval, warn };
}
describe("optional delivery tracking", () => {
  it("without the webhook secret never schedules or reconciles accepted/uncertain rows", async () => {
    const f = fixture(false);
    f.worker.onApplicationBootstrap();
    await f.worker.reconcile();
    await f.worker.beforeApplicationShutdown();
    expect(f.setInterval).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });
  it("coalesces ticks and waits for a running bounded reconciliation on shutdown", async () => {
    let resolve!: () => void;
    const work = new Promise<void>((done) => {
      resolve = done;
    });
    const f = fixture(
      true,
      vi.fn(() => work),
    );
    f.worker.onApplicationBootstrap();
    expect(f.setInterval).toHaveBeenCalledWith(expect.any(Function), 60000);
    const first = f.worker.reconcile();
    expect(f.worker.reconcile()).toBe(first);
    expect(f.reconcile).toHaveBeenCalledOnce();
    const stopped = vi.fn();
    const closing = f.worker.beforeApplicationShutdown().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    resolve();
    await closing;
    expect(f.clearInterval).toHaveBeenCalledWith("timer");
    expect(stopped).toHaveBeenCalledOnce();
  });
  it("logs only a stable error code and releases the running flag after failure", async () => {
    const f = fixture(true, vi.fn().mockRejectedValue(new Error("PRIVATE_PROVIDER_MARKER")));
    await f.worker.reconcile();
    await f.worker.reconcile();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.warn).toHaveBeenCalledWith("email.delivery_reconcile_failed", {});
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain("PRIVATE_PROVIDER_MARKER");
  });
});
