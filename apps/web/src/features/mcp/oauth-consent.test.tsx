import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubNavigation } from "@/features/access/test-support";
import { authorizationBridgeUrl, OAuthConsent, oauthReturnUrl } from "./oauth-consent.tsx";
import { fakeAgentAccessApi, id, renderAgentAccess, taskId } from "./test-support.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/oauth/consent",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
let location: ReturnType<typeof stubNavigation>;
beforeEach(() => {
  location = stubNavigation(`/oauth/consent?request=${id}`);
});
afterEach(() => {
  location.restore();
});

describe("owner-only OAuth consent", () => {
  it("shows the client provenance, loopback warning and actual requested permissions", async () => {
    renderAgentAccess(<OAuthConsent />);
    expect(await screen.findByText("Research client")).toBeInTheDocument();
    expect(screen.getByText("Unverified client")).toBeInTheDocument();
    expect(screen.getByText(/program running on your device/)).toBeInTheDocument();
    expect(screen.getByText(/agent.example/)).toHaveTextContent("localhost");
    expect(screen.getByText("Read tasks and pages")).toBeInTheDocument();
    expect(screen.getByLabelText("Selected tasks only")).toBeChecked();
    expect(screen.getByText(/continued access/)).toBeInTheDocument();
  });
  it("requires selection and folds only the trusted request id into its decision", async () => {
    const user = userEvent.setup();
    const api = fakeAgentAccessApi();
    const { navigate } = renderAgentAccess(<OAuthConsent />, api);
    await user.click(await screen.findByRole("button", { name: "Allow selected access" }));
    expect(api.decide).not.toHaveBeenCalled();
    expect(await screen.findByText(/Select at least one task/)).toBeInTheDocument();
    await user.click(await screen.findByLabelText("Plan a quiet weekend"));
    await user.click(screen.getByRole("button", { name: "Allow selected access" }));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith(
        id,
        { decision: "allow", taskIds: [taskId] },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(navigate).toHaveBeenCalledWith("http://localhost:4321/callback?code=test");
  });
  it("denies without requiring a task selection", async () => {
    const api = fakeAgentAccessApi();
    renderAgentAccess(<OAuthConsent />, api);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Deny" }));
    expect(api.decide).toHaveBeenCalledWith(
      id,
      { decision: "deny" },
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it("explains a consumed one-time redirect instead of guessing a code", async () => {
    const api = fakeAgentAccessApi({
      decide: vi.fn(async () => ({ requestId: id, secretUnavailable: true })),
    });
    const { navigate } = renderAgentAccess(<OAuthConsent />, api);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Deny" }));
    expect(
      await screen.findByText(/cannot reveal its authorization code again/),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("refuses expired requests", async () => {
    const api = fakeAgentAccessApi();
    const current = await api.consent(id, new AbortController().signal);
    api.consent = vi.fn(async () => ({ ...current, expiresAt: 1 }));
    renderAgentAccess(<OAuthConsent />, api);
    expect(await screen.findByText(/This request expired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow selected access" })).toBeDisabled();
  });
  it("does not read missing or malformed request ids", async () => {
    location.setPath("/oauth/consent?request=foreign/../../");
    const api = fakeAgentAccessApi();
    renderAgentAccess(<OAuthConsent />, api);
    expect(await screen.findByText(/missing or invalid/)).toBeInTheDocument();
    expect(api.consent).not.toHaveBeenCalled();
  });
  it.each(["javascript:alert(1)", "http://evil.example/", "https://user:secret@example.com/"])(
    "rejects unsafe redirect %s",
    (url) => {
      expect(() => oauthReturnUrl(url)).toThrow();
    },
  );
  it("allows an attested loopback OAuth return, which is how a local MCP client comes back", () => {
    expect(oauthReturnUrl("http://127.0.0.1:8123/cb")).toBe("http://127.0.0.1:8123/cb");
  });
  it("keeps the post-login bridge on the configured API origin", () => {
    const target = authorizationBridgeUrl(
      "https://api.example",
      "?redirect_uri=https%3A%2F%2Fevil.example&state=x",
    );
    expect(new URL(target).origin).toBe("https://api.example");
    expect(new URL(target).pathname).toBe("/oauth/authorize");
    expect(new URL(target).searchParams.get("state")).toBe("x");
  });
});
