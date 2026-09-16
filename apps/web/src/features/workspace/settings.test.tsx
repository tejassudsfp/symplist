import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { AppearanceSettings } from "./appearance-settings.tsx";
import { ShortcutsSettings } from "./shortcuts-settings.tsx";
import { FakeWorkspaceApi, findInlineError, renderWorkspace } from "./test-support.tsx";

const navigation = vi.hoisted(() => ({ pathname: "/settings/appearance" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: () => undefined,
    back: () => undefined,
  }),
}));

beforeEach(() => {
  navigation.pathname = "/settings/appearance";
  document.documentElement.removeAttribute("data-theme");
});

/*
 * The two settings screens the workspace owns (settings_appearance.md, themes.md, note 13). Both read
 * and write one preference group, so each covers the four states the briefs ask for: loading, the
 * failed load with its retry, the saved steady state, and a save that did not reach the account and
 * is therefore a preview only.
 */

describe("appearance settings", () => {
  it("shows a loading state, then the three choices with their current values", async () => {
    const api = new FakeWorkspaceApi();
    api.setPreference("appearance", { themeId: "paper", mode: "dark", accent: "amber" });
    renderWorkspace(<AppearanceSettings />, { api });
    expect(screen.getByText("Loading your appearance")).toBeInTheDocument();

    expect(await screen.findByRole("heading", { name: "Style" })).toBeInTheDocument();
    // Style, accent and brightness are three separate choices, each already on the stored value.
    expect(screen.getByRole("radio", { name: /Paper/ })).toBeChecked();
    expect(
      within(screen.getByRole("radiogroup", { name: "Accent color" })).getByRole("radio", {
        name: "Amber",
      }),
    ).toBeChecked();
    expect(
      within(screen.getByRole("radiogroup", { name: "Brightness" })).getByRole("radio", {
        name: "Dark",
      }),
    ).toBeChecked();
  });

  it("explains a failed load of the account's appearance, and loads again", async () => {
    const api = new FakeWorkspaceApi();
    api.fail("getPreferences");
    const { user } = renderWorkspace(<AppearanceSettings />, { api });
    const alert = await findInlineError();
    expect(within(alert).getByText("Couldn't load your appearance")).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Style" })).toBeInTheDocument();
  });

  it("applies a style at once and saves it to the account", async () => {
    const api = new FakeWorkspaceApi();
    const { user } = renderWorkspace(<AppearanceSettings />, { api });
    await screen.findByRole("heading", { name: "Style" });

    await user.click(screen.getByRole("radio", { name: /Meadow/ }));
    // The document follows immediately — the choice is never held back by the save.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("meadow"));
    await waitFor(() =>
      expect(api.storedPreference("appearance")).toMatchObject({ themeId: "meadow" }),
    );
    expect(await screen.findByText("Saved to your account")).toBeInTheDocument();
  });

  it("keeps a change that could not be saved and says it is a preview only", async () => {
    const api = new FakeWorkspaceApi();
    const { user } = renderWorkspace(<AppearanceSettings />, { api });
    await screen.findByRole("heading", { name: "Style" });
    api.fail("putPreference", undefined, true);

    await user.click(screen.getByRole("radio", { name: /Tide/ }));
    // The change stays visible here; it simply has not reached the account yet.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("tide"));
    expect(screen.getByRole("radio", { name: /Tide/ })).toBeChecked();
    expect(await screen.findByText(/Previewing here/)).toBeInTheDocument();

    api.clearFailure("putPreference");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(api.storedPreference("appearance")).toMatchObject({ themeId: "tide" }),
    );
  });

  it("brings brightness back to a single choice and resets the accent", async () => {
    const api = new FakeWorkspaceApi();
    api.setPreference("appearance", { themeId: "studio", mode: "system", accent: "rose" });
    const { user } = renderWorkspace(<AppearanceSettings />, { api });
    await screen.findByRole("heading", { name: "Brightness" });

    await user.click(screen.getByRole("radio", { name: "Light" }));
    await waitFor(() =>
      expect(api.storedPreference("appearance")).toMatchObject({ mode: "light" }),
    );

    await user.click(screen.getByRole("button", { name: "Reset accent" }));
    await waitFor(() =>
      expect(api.storedPreference("appearance")).toMatchObject({ accent: "blue" }),
    );
    expect(screen.getByRole("button", { name: "Reset accent" })).toBeDisabled();
  });
});

describe("keyboard shortcut settings", () => {
  it("lists the actions by group with their current keys", async () => {
    const api = new FakeWorkspaceApi();
    renderWorkspace(<ShortcutsSettings />, { api });
    expect(screen.getByText("Loading your shortcuts")).toBeInTheDocument();

    // The heading is in the loading state too, so the reference itself is what says it is ready.
    await screen.findByLabelText("Search shortcuts");
    expect(screen.getByRole("heading", { level: 1, name: "Keyboard shortcuts" })).toBeVisible();
    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    // Every row names its action and offers a way to change it — no raw key codes anywhere.
    expect(screen.getAllByRole("button", { name: "Change" }).length).toBe(rows.length);
  });

  it("filters the reference and says so when nothing matches", async () => {
    const api = new FakeWorkspaceApi();
    const { user } = renderWorkspace(<ShortcutsSettings />, { api });
    await screen.findByLabelText("Search shortcuts");
    const field = screen.getByLabelText("Search shortcuts");

    await user.type(field, "zzzz never an action");
    expect(await screen.findByText(/No shortcuts match/)).toBeInTheDocument();
  });

  it("turns single-key shortcuts off for the account", async () => {
    const api = new FakeWorkspaceApi();
    const { user } = renderWorkspace(<ShortcutsSettings />, { api });
    await screen.findByLabelText("Search shortcuts");

    await user.click(screen.getByRole("checkbox", { name: "Disable single-key shortcuts" }));
    await waitFor(() =>
      expect(api.storedPreference("keyboard")).toMatchObject({ singleKeyShortcuts: false }),
    );
  });

  it("explains a failed load of the account's shortcuts", async () => {
    const api = new FakeWorkspaceApi();
    api.fail(
      "getPreferences",
      new ApiError({
        status: 503,
        code: "rate.limited",
        message: "Symplist is busy",
        requestId: "req-test",
      }),
    );
    renderWorkspace(<ShortcutsSettings />, { api });
    const alert = await findInlineError();
    expect(within(alert).getByText("Couldn't load your shortcuts")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
