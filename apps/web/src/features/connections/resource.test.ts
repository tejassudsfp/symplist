import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionResource } from "./resource.ts";
import { deferred } from "./test-support.tsx";

describe("memory-only connections resources", () => {
  it("turns a synchronous missing-configuration failure into a recoverable state", async () => {
    const load = vi.fn((): Promise<string> => {
      throw new Error("missing config");
    });
    const resource = new ConnectionResource(load);
    expect(() => resource.open()).not.toThrow();
    await waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().error).toBeTruthy();
    resource.close();
  });
  it("reopens after StrictMode cleanup and ignores the old result", async () => {
    const old = deferred<string>();
    const next = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const resource = new ConnectionResource<string>(load);
    resource.open();
    resource.close();
    resource.open();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[0]?.[0].aborted).toBe(true);
    old.resolve("Old account");
    next.resolve("Current account");
    await waitFor(() =>
      expect(resource.getSnapshot()).toEqual({
        data: "Current account",
        loading: false,
        error: null,
      }),
    );
    resource.close();
    expect(resource.getSnapshot().data).toBeNull();
  });
  it("coalesces concurrent hints into one follow-up read", async () => {
    const first = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("fresh");
    const resource = new ConnectionResource<string>(load);
    resource.open();
    for (let index = 0; index < 100; index++) resource.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve("old");
    await waitFor(() => expect(resource.getSnapshot().data).toBe("fresh"));
    expect(load).toHaveBeenCalledTimes(2);
    resource.close();
  });
  it("recovers failed loading with an explicit retry", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("private provider body"))
      .mockResolvedValue("ready");
    const resource = new ConnectionResource<string>(load);
    resource.open();
    await waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().error).not.toContain("private provider");
    expect(resource.getSnapshot().error).toBeTruthy();
    resource.refresh();
    await waitFor(() =>
      expect(resource.getSnapshot()).toEqual({ data: "ready", loading: false, error: null }),
    );
    resource.close();
  });
  it("notifies subscribers and does not reload closed resources", () => {
    const load = vi.fn(async () => "x");
    const resource = new ConnectionResource(load);
    const listener = vi.fn();
    const stop = resource.subscribe(listener);
    resource.open();
    expect(listener).toHaveBeenCalled();
    stop();
    listener.mockClear();
    resource.close();
    resource.refresh();
    expect(listener).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
