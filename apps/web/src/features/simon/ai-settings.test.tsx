import type { AiProvider, AiSettings } from "@symplist/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AiSettingsScreen } from "./ai-settings.tsx";
import type { AiSettingsApi } from "./ai-settings-api.ts";

const now = 1_758_000_000_000;

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    keys: [
      { provider: "openai", configured: false, createdAt: null, updatedAt: null, verifiedAt: null },
      {
        provider: "anthropic",
        configured: false,
        createdAt: null,
        updatedAt: null,
        verifiedAt: null,
      },
    ],
    tiers: [
      { tier: "fast", provider: "openai", model: "gpt-5.6-luna", ready: false, chosen: false },
      { tier: "smart", provider: "openai", model: "gpt-5.6-terra", ready: false, chosen: false },
    ],
    usable: false,
    suggestions: [
      { provider: "openai", models: ["gpt-5.6-luna"] },
      { provider: "anthropic", models: ["claude-opus-5-5"] },
    ],
    ...overrides,
  };
}

function configured(provider: AiProvider): AiSettings {
  const base = settings();
  return {
    ...base,
    keys: base.keys.map((key) =>
      key.provider === provider
        ? { ...key, configured: true, createdAt: now, updatedAt: now, verifiedAt: null }
        : key,
    ),
    tiers: base.tiers.map((tier) => ({ ...tier, ready: tier.provider === provider })),
    usable: true,
  };
}

function fakeApi(initial: AiSettings, overrides: Partial<AiSettingsApi> = {}): AiSettingsApi {
  return {
    settings: async () => initial,
    setKey: async () => undefined,
    clearKey: async () => undefined,
    setModels: async () => initial,
    ...overrides,
  };
}

/** One provider's card. Both are on screen and their fields share a label, so queries scope here. */
async function card(provider: AiProvider): Promise<HTMLElement> {
  return await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      `[data-slot="provider-key"][data-provider="${provider}"]`,
    );
    expect(element).not.toBeNull();
    return element as HTMLElement;
  });
}

describe("model settings", () => {
  it("says Simon cannot run until a key is added", async () => {
    render(<AiSettingsScreen api={fakeApi(settings())} />);
    expect(await screen.findByText(/Simon needs a key before it can answer/u)).toBeInTheDocument();
  });

  it("drops the warning once a provider is configured", async () => {
    render(<AiSettingsScreen api={fakeApi(configured("openai"))} />);
    await card("openai");
    expect(screen.queryByText(/Simon needs a key before it can answer/u)).toBeNull();
  });

  it("sends a typed key once and never puts it back on screen", async () => {
    const user = userEvent.setup();
    const setKey = vi.fn<AiSettingsApi["setKey"]>(async () => undefined);
    const api = fakeApi(settings(), { setKey });
    render(<AiSettingsScreen api={api} />);

    const openai = await card("openai");
    const field = within(openai).getByLabelText("API key");
    await user.type(field, "sk-typed-secret-0123456789");
    await user.click(within(openai).getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(setKey).toHaveBeenCalledTimes(1));
    expect(setKey.mock.calls[0]?.[1]).toBe("sk-typed-secret-0123456789");
    // Cleared from the field, so it is not left in the DOM for a screenshot or a re-render.
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("sk-typed-secret-0123456789");
  });

  it("masks the key field, so it is not readable over a shoulder", async () => {
    render(<AiSettingsScreen api={fakeApi(settings())} />);
    expect(within(await card("openai")).getByLabelText("API key")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("will not send an empty key", async () => {
    const user = userEvent.setup();
    const setKey = vi.fn<AiSettingsApi["setKey"]>(async () => undefined);
    render(<AiSettingsScreen api={fakeApi(settings(), { setKey })} />);
    const save = within(await card("openai")).getByRole("button", { name: "Save key" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(setKey).not.toHaveBeenCalled();
  });

  it("reports a configured key by date, never by value", async () => {
    render(<AiSettingsScreen api={fakeApi(configured("openai"))} />);
    expect(await screen.findByText(/Saved .* · not used yet/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("says which tier cannot run and why", async () => {
    const base = configured("openai");
    render(
      <AiSettingsScreen
        api={fakeApi({
          ...base,
          tiers: base.tiers.map((tier) =>
            tier.tier === "smart"
              ? { ...tier, provider: "anthropic", model: "claude-opus-5-5", ready: false }
              : tier,
          ),
        })}
      />,
    );
    expect(
      await screen.findByText("This tier needs an Anthropic key before it can run."),
    ).toBeInTheDocument();
  });

  it("lets a tier move to the other provider", async () => {
    const user = userEvent.setup();
    const setModels = vi.fn<AiSettingsApi["setModels"]>(async () => configured("openai"));
    render(<AiSettingsScreen api={fakeApi(configured("openai"), { setModels })} />);
    const selects = await screen.findAllByLabelText("Provider");
    await user.selectOptions(selects[1] as HTMLElement, "anthropic");
    await waitFor(() => expect(setModels).toHaveBeenCalledTimes(1));
    expect(setModels.mock.calls[0]?.[0]).toMatchObject({ smart: { provider: "anthropic" } });
  });

  it("reports a failed save without claiming the key was stored", async () => {
    const user = userEvent.setup();
    render(
      <AiSettingsScreen
        api={fakeApi(settings(), {
          setKey: async () => {
            throw new Error("refused");
          },
        })}
      />,
    );
    const openai = await card("openai");
    await user.type(within(openai).getByLabelText("API key"), "sk-rejected-0123456789ab");
    await user.click(within(openai).getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("That didn't save")).toBeInTheDocument();
  });
});
