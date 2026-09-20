import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionsProvider, useActions } from "./provider.tsx";
import type { ActionServices, AppAction } from "./types.ts";

function services(): ActionServices {
  return { navigate: vi.fn(), assign: vi.fn(), announce: vi.fn(), route: null, shell: null };
}

const palette: AppAction = {
  id: "palette.open",
  label: "Open command palette",
  context: "app",
  defaultBinding: "mod+k",
  availability: () => ({ enabled: true }),
  run: vi.fn(),
};

const stop: AppAction = {
  id: "run.stop",
  label: "Stop Simon",
  context: "app",
  availability: () => ({ enabled: false, reason: "Simon isn't running" }),
  run: vi.fn(),
};

function Labels() {
  const { bindingLabel, invoke, platform } = useActions();
  return (
    <div>
      <span data-testid="platform">{platform}</span>
      <span data-testid="palette">{bindingLabel("palette.open")?.display ?? "unbound"}</span>
      <span data-testid="palette-spoken">{bindingLabel("palette.open")?.spoken ?? ""}</span>
      <span data-testid="stop">{bindingLabel("run.stop")?.display ?? "unbound"}</span>
      <button type="button" onClick={() => void invoke("run.stop", "pointer")}>
        Stop
      </button>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ActionsProvider", () => {
  it("labels bindings for the platform and honors remaps", () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel", userAgent: "Macintosh" });
    const { rerender } = render(
      <ActionsProvider actions={[palette, stop]} services={services()}>
        <Labels />
      </ActionsProvider>,
    );
    expect(screen.getByTestId("platform")).toHaveTextContent("mac");
    expect(screen.getByTestId("palette")).toHaveTextContent("⌘K");
    expect(screen.getByTestId("palette-spoken")).toHaveTextContent("Command K");
    expect(screen.getByTestId("stop")).toHaveTextContent("unbound");
    rerender(
      <ActionsProvider
        actions={[palette, stop]}
        services={services()}
        preferences={{ overrides: { "palette.open": "mod+p" }, singleKeyShortcuts: true }}
      >
        <Labels />
      </ActionsProvider>,
    );
    expect(screen.getByTestId("palette")).toHaveTextContent("⌘P");
  });

  it("uses Control labels elsewhere and dispatches document key presses", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32", userAgent: "Windows" });
    const user = userEvent.setup();
    render(
      <ActionsProvider actions={[palette, stop]} services={services()}>
        <Labels />
      </ActionsProvider>,
    );
    expect(screen.getByTestId("palette")).toHaveTextContent("Ctrl+K");
    await user.keyboard("{Control>}k{/Control}");
    expect(palette.run).toHaveBeenCalledTimes(1);
  });

  it("announces a disabled action's reason when a button invokes it", async () => {
    const shellServices = services();
    const user = userEvent.setup();
    render(
      <ActionsProvider actions={[palette, stop]} services={shellServices}>
        <Labels />
      </ActionsProvider>,
    );
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(stop.run).not.toHaveBeenCalled();
    expect(shellServices.announce).toHaveBeenCalledWith("Stop Simon: Simon isn't running");
  });

  it("reports an action's availability without running it", async () => {
    const shellServices = services();
    function Availability() {
      const { availability } = useActions();
      const stopState = availability("run.stop", "palette");
      const paletteState = availability("palette.open", "palette");
      return (
        <div>
          <span data-testid="stop-state">
            {stopState ? `${stopState.enabled}:${stopState.reason ?? ""}` : "none"}
          </span>
          <span data-testid="palette-state">
            {paletteState ? String(paletteState.enabled) : "none"}
          </span>
          <span data-testid="missing-state">
            {availability("missing", "palette") ? "some" : "none"}
          </span>
        </div>
      );
    }
    const { rerender } = render(
      <ActionsProvider actions={[palette, stop]} services={shellServices}>
        <Availability />
      </ActionsProvider>,
    );
    // The dispatcher attaches in an effect; the next render reads it.
    rerender(
      <ActionsProvider actions={[palette, stop]} services={shellServices}>
        <Availability />
      </ActionsProvider>,
    );
    expect(screen.getByTestId("stop-state")).toHaveTextContent("false:Simon isn't running");
    expect(screen.getByTestId("palette-state")).toHaveTextContent("true");
    expect(screen.getByTestId("missing-state")).toHaveTextContent("none");
    expect(stop.run).not.toHaveBeenCalled();
    expect(shellServices.announce).not.toHaveBeenCalled();
  });

  it("stops listening when unmounted", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const { unmount } = render(
      <ActionsProvider actions={[{ ...palette, run }]} services={services()}>
        <Labels />
      </ActionsProvider>,
    );
    unmount();
    await user.keyboard("{Control>}k{/Control}{Meta>}k{/Meta}");
    expect(run).not.toHaveBeenCalled();
  });
});
