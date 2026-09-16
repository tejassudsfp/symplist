import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { deferred } from "./test-support.tsx";
import { useIntent } from "./use-intent.ts";

const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
describe("one user intent across retries and effect lifetimes", () => {
  it("allows correcting a definitively refused validation request", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({ status: 422, code: "validation", requestId: "test", message: "Refused" }),
      )
      .mockResolvedValue("saved");
    const { result } = renderHook(() => useIntent<string, string>(execute, vi.fn()), { wrapper });
    await act(async () => result.current.run("invalid"));
    expect(result.current.uncertain).toBe(false);
    await act(async () => result.current.run("corrected"));
    expect(execute.mock.calls[1]?.[0]).toBe("corrected");
    expect(execute.mock.calls[1]?.[1]).not.toBe(execute.mock.calls[0]?.[1]);
  });
  it("can save after StrictMode cleanup/re-entry", async () => {
    const execute = vi.fn(async (input: string) => input);
    const applied = vi.fn();
    const { result } = renderHook(() => useIntent(execute, applied), { wrapper });
    await act(async () => result.current.run("save"));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith("save");
    expect(result.current.busy).toBe(false);
  });
  it("prevents same-tick double submit before React renders busy", async () => {
    const pending = deferred<string>();
    const execute = vi.fn(() => pending.promise);
    const applied = vi.fn();
    const { result } = renderHook(() => useIntent(execute, applied), { wrapper });
    act(() => {
      void result.current.run("one");
      void result.current.run("two");
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    await act(async () => pending.resolve("done"));
    expect(result.current.busy).toBe(false);
  });
  it("never changes input or key while the outcome is uncertain", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("private error body"))
      .mockResolvedValue("done");
    const { result } = renderHook(() => useIntent<string, string>(execute, vi.fn()), { wrapper });
    await act(async () => result.current.run("original"));
    expect(result.current.uncertain).toBe(true);
    expect(result.current.error).not.toContain("private error");
    await act(async () => result.current.run("changed"));
    expect(execute.mock.calls[1]?.slice(0, 2)).toEqual(execute.mock.calls[0]?.slice(0, 2));
    expect(result.current.uncertain).toBe(false);
  });
  it("aborts on unmount and ignores a late successful key response", async () => {
    const pending = deferred<string>();
    const execute = vi.fn((_input: string, _key: string, _signal: AbortSignal) => pending.promise);
    const applied = vi.fn();
    const { result, unmount } = renderHook(() => useIntent<string, string>(execute, applied), {
      wrapper,
    });
    act(() => {
      void result.current.run("secret request");
    });
    unmount();
    expect(execute.mock.calls[0]?.[2]?.aborted).toBe(true);
    await act(async () => pending.resolve("raw-key"));
    await waitFor(() => expect(applied).not.toHaveBeenCalled());
  });
});
