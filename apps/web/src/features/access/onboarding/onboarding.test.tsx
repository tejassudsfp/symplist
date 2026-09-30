import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError } from "@/lib/api";
import {
  admittedAccess,
  createFakeAccessApi,
  mayaMe,
  renderAccess,
  stubNavigation,
} from "../test-support.tsx";
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

describe("onboarding (onboarding_name.md)", () => {
  it("asks one question, with no progression to show and no questionnaire", async () => {
    renderAccess(<OnboardingName />, { me: nameStep });
    expect(
      await screen.findByRole("heading", { name: "What should we call you?" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    // There is one page, so there is no step counter: the connector invitation that made it a
    // two-step flow left with the server-side agent (note 18).
    expect(screen.queryByRole("list", { name: /Step \d of \d/ })).not.toBeInTheDocument();
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

  it("saves the name, completes onboarding and opens the workspace", async () => {
    // Two calls behind one submit: the stored `onboarding_step` still passes through `connections` on
    // its way to `done`, because a value in a column cannot be dropped and this repository's migrations
    // are expand-only. The person sees one question, which is the point.
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      updateDisplayName: vi.fn(async () => connectionsStep),
      completeOnboarding: vi.fn(async () => mayaMe()),
    });
    renderAccess(<OnboardingName />, { api, me: nameStep });
    await user.type(await screen.findByLabelText("Name"), "Maya");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.updateDisplayName).toHaveBeenCalledWith("Maya"));
    await waitFor(() => expect(api.completeOnboarding).toHaveBeenCalledOnce());
    expect(navigation.replace).toHaveBeenCalledWith("/now");
  });

  it("stays put and explains itself when completing onboarding fails", async () => {
    // The name was saved and the account is mid-transition; telling them it worked would be a lie, and
    // sending them to a workspace the gate will bounce them out of is worse.
    const user = userEvent.setup();
    const api = createFakeAccessApi({
      updateDisplayName: vi.fn(async () => connectionsStep),
      completeOnboarding: vi.fn(async () => {
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
    expect(navigation.replace).not.toHaveBeenCalledWith("/now");
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

  it("prefills a saved name for an account stranded at the old second step", async () => {
    // `connections` is still a stored value, so an account that gave its name before this change lands
    // back here rather than nowhere, and one submit finishes it.
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
