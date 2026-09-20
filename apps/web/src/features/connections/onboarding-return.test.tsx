import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preserveConnectionCallback } from "@/features/access/navigation";
import { SessionGate } from "@/features/access/session";
import {
  admittedAccess,
  mayaMe,
  renderAccess,
  stubNavigation,
} from "@/features/access/test-support";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/connections",
  useRouter: () => ({ push: vi.fn(), replace: navigation.replace }),
}));
afterEach(() => vi.clearAllMocks());

describe("provider callback through the real onboarding gate", () => {
  it.each(["connected", "failed", "cancelled"])("preserves only the %s outcome", async (result) => {
    const location = stubNavigation(
      `/settings/connections?result=${result}&key=discard&next=https://evil.example`,
    );
    try {
      renderAccess(
        <SessionGate require="admitted">
          <p>Not yet admitted to the workspace</p>
        </SessionGate>,
        { me: mayaMe({ access: { ...admittedAccess, onboardingStep: "connections" } }) },
      );
      await waitFor(() =>
        expect(navigation.replace).toHaveBeenCalledWith(`/welcome/connections?result=${result}`),
      );
    } finally {
      location.restore();
    }
  });
  it("never propagates arbitrary query data or outcomes to other gates", () => {
    expect(
      preserveConnectionCallback(
        "/welcome/connections",
        "/settings/connections?result=https://evil.example",
      ),
    ).toBe("/welcome/connections");
    expect(
      preserveConnectionCallback("/access/paused", "/settings/connections?result=connected"),
    ).toBe("/access/paused");
    expect(
      preserveConnectionCallback(
        "/welcome/connections",
        "https://evil.example/settings/connections?result=connected",
      ),
    ).toBe("/welcome/connections");
    expect(preserveConnectionCallback("/welcome/connections", "/now?result=connected")).toBe(
      "/welcome/connections",
    );
  });
});
