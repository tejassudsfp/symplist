import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  accessApiError,
  admittedAccess,
  createFakeAccessApi,
  mayaMe,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
import { OnboardingConnections } from "./connections-step.tsx";
import { OnboardingName } from "./name-step.tsx";

const navigation = vi.hoisted(() => ({ pathname: "/welcome", push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

let location = stubNavigation("/welcome");

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  location = stubNavigation("/welcome");
});

afterEach(() => {
  location.restore();
});

const nameStep = mayaMe({
  access: { ...admittedAccess, onboardingStep: "name" },
  user: { displayName: null } as never,
});
const connectionsStep = mayaMe({
  access: { ...admittedAccess, onboardingStep: "connections" },
});

describe("onboarding, the name step (onboarding_name.md)", () => {
  it("asks one question with a two-step progression and no questionnaire", async () => {
    renderAccess(<OnboardingName />, { me: nameStep });
    expect(
      await screen.findByRole("heading", { name: "What should we call you?" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByRole("list", { name: "Step 1 of 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/company size|job role|productivity style/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/payment|plan/i)).not.toBeInTheDocument();
  });

  it("requires a name and keeps what was typed", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ updateDisplayName: vi.fn() });
    renderAccess(<OnboardingName />, { api, me: nameStep });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Enter a name so Symplist knows what to call you."),
    ).toBeInTheDocument();
    expect(api.updateDisplayName).not.toHaveBeenCalled();
  });

  it("refuses a name longer than the limit before sending it", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ updateDisplayName: vi.fn() });
    renderAccess(<OnboardingName />, { api, me: nameStep });
    const field = await screen.findByLabelText("Name");
    await user.click(field);
    await user.paste("M".repeat(81));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Names can be up to 80 characters.")).toBeInTheDocument();
    expect(api.updateDisplayName).not.toHaveBeenCalled();
  });

  it("saves the name and continues to connections", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ updateDisplayName: vi.fn(async () => connectionsStep) });
    renderAccess(<OnboardingName />, { api, me: nameStep });
    await user.type(await screen.findByLabelText("Name"), "Maya");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.updateDisplayName).toHaveBeenCalledWith("Maya"));
    expect(navigation.push).toHaveBeenCalledWith("/welcome/connections");
  });

  it("keeps the typed name when saving fails and allows a retry", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      updateDisplayName: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderAccess(<OnboardingName />, { api, me: nameStep });
    await user.type(await screen.findByLabelText("Name"), "Maya");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(
        "Symplist couldn't be reached, so your name wasn't saved. Try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Maya");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("prefills a saved name on a resumed flow, without a second welcome", async () => {
    renderAccess(<OnboardingName />, { me: connectionsStep });
    expect(await screen.findByLabelText("Name")).toHaveValue("Maya Rao");
    expect(screen.queryByText(/Welcome to Symplist/)).not.toBeInTheDocument();
    expect(screen.getByText(/This is the name in your profile menu/)).toBeInTheDocument();
  });

  it("offers only account actions in its menu, never the app", async () => {
    const user = userEvent.setup();
    renderAccess(<OnboardingName />, { me: nameStep });
    await user.click(await screen.findByRole("button", { name: /Account menu/ }));
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveTextContent("Sign out");
    expect(menu).not.toHaveTextContent("Archive");
  });

  it("sends an account that finished onboarding back to the app", async () => {
    renderAccess(<OnboardingName />, { me: mayaMe() });
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/now"));
  });
});

describe("onboarding, the connections step (onboarding_connections.md)", () => {
  it("offers Continue and Skip equally, with the neutral state when no connectors exist", async () => {
    renderAccess(<OnboardingConnections />, { me: connectionsStep });
    expect(
      await screen.findByRole("heading", { name: "Connect what you use" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You can do this later. Nothing in Symplist needs a connected service."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
    expect(await screen.findByText("No connectors are set up here yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Actions that send or change something outside Symplist still ask you/),
    ).toBeInTheDocument();
  });

  it("shows the connector tiles the connections feature supplies", async () => {
    renderAccess(<OnboardingConnections catalogue={<p>Gmail, Calendar and GitHub</p>} />, {
      me: connectionsStep,
    });
    expect(await screen.findByText("Gmail, Calendar and GitHub")).toBeInTheDocument();
    expect(screen.queryByText("No connectors are set up here yet")).not.toBeInTheDocument();
  });

  it("finishes onboarding from Continue and from Skip for now", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({ completeOnboarding: vi.fn(async () => mayaMe()) });
    const { unmount } = renderAccess(<OnboardingConnections />, { api, me: connectionsStep });
    await user.click(await screen.findByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/now"));
    unmount();

    navigation.replace.mockReset();
    renderAccess(<OnboardingConnections />, { api, me: connectionsStep });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/now"));
    expect(api.completeOnboarding).toHaveBeenCalledTimes(2);
  });

  it("returns to the name step, where the saved name is still there", async () => {
    const user = userEvent.setup();
    renderAccess(<OnboardingConnections />, { me: connectionsStep });
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(navigation.push).toHaveBeenCalledWith("/welcome");
  });

  it("goes back to the name step when the api says the name is still missing", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      completeOnboarding: vi.fn(async () => {
        throw accessApiError("onboarding.name_required", 409);
      }),
    });
    renderAccess(<OnboardingConnections />, { api, me: connectionsStep });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/welcome"));
  });

  it("explains a failure to finish and stays on the step", async () => {
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      completeOnboarding: vi.fn(async () => {
        throw new ApiNetworkError();
      }),
    });
    renderAccess(<OnboardingConnections />, { api, me: connectionsStep });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Symplist couldn't be reached. Check your connection and try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});
