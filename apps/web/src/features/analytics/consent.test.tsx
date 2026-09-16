import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mayaMe, renderAccess } from "@/features/access/test-support";
import { ConsentBanner } from "./consent-banner.tsx";
import { PrivacySettings } from "./privacy-settings.tsx";
import { resetAnalytics } from "./runtime.ts";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getApiClient: () => api,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/now" }));
beforeEach(() => {
  resetAnalytics();
  vi.clearAllMocks();
  api.get.mockResolvedValue({ enabled: true, consent: { state: "unset", decidedAt: null } });
  api.put.mockImplementation(async (_path, options) => ({
    enabled: true,
    consent: { state: options.body.state, decidedAt: 123 },
  }));
});
describe("mandatory equal-choice consent", () => {
  it("shows equally styled choices, saves decline and mirrors it in account privacy", async () => {
    renderAccess(
      <>
        <ConsentBanner />
        <PrivacySettings />
      </>,
      { me: mayaMe() },
    );
    const accept = await screen.findByRole("button", { name: "Accept" });
    const decline = screen.getByRole("button", { name: "Decline" });
    expect(accept.className).toBe(decline.className);
    await userEvent.click(decline);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("checkbox", { name: "Share product usage" })).not.toBeChecked();
    expect(api.put).toHaveBeenCalledWith(
      "/v1/analytics/consent",
      expect.objectContaining({ body: { state: "denied" } }),
    );
    expect(api.post).not.toHaveBeenCalled();
  });
  it("does not imply consent after a failed accept and supports a retry", async () => {
    api.put.mockRejectedValueOnce(new Error("offline"));
    renderAccess(<ConsentBanner />, { me: mayaMe() });
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument(),
    );
  });
  it("hides optional collection when the deployment has disabled analytics", async () => {
    api.get.mockResolvedValue({ enabled: false, consent: { state: "unset", decidedAt: null } });
    renderAccess(
      <>
        <ConsentBanner />
        <PrivacySettings />
      </>,
      { me: mayaMe() },
    );
    await screen.findByText("Product analytics is disabled for this deployment.");
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
