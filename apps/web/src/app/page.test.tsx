import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT ${href}`);
});

vi.mock("next/navigation", () => ({ redirect }));

describe("HomePage", () => {
  it("opens the task workspace", async () => {
    const { default: HomePage } = await import("./page");
    expect(() => HomePage()).toThrow("NEXT_REDIRECT /now");
    expect(redirect).toHaveBeenCalledWith("/now");
  });
});
