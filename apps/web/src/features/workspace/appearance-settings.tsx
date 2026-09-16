"use client";

import { Check } from "lucide-react";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  type AccentChoice,
  accentPresetIds,
  accentPresets,
  accentSeed,
  DEFAULT_ACCENT,
  isAccentPresetId,
  normalizeCustomAccent,
} from "@/theme/accent";
import {
  type Appearance,
  DEFAULT_APPEARANCE,
  type ModePreference,
  modePreferences,
  normalizeAppearance,
} from "@/theme/appearance";
import { type ColorMode, isThemeId, type ThemeId, themeIds, themes } from "@/theme/registry";
import { loadFailureCopy, previewOnlyMessage } from "./errors.ts";
import { ThemeMiniature, useResolvedAccent } from "./theme-preview.tsx";
import { usePreferenceGroup, usePreferencesStatus, useWorkspace } from "./workspace-provider.tsx";

const modeLabels: Readonly<Record<ModePreference, string>> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** The brightness a `system` preference resolves to right now, so previews match the workspace. */
function useEffectiveMode(mode: ModePreference): ColorMode {
  const prefersDark = useSyncExternalStore(
    (listener) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => undefined;
      }
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

/**
 * Settings → Appearance (settings_appearance.md, note 02): a gallery of real miniature workspaces,
 * an accent palette with a custom color, and Light / Dark / System — three independent choices that
 * preview at once and save to the account by themselves. A failed save says plainly that the change is
 * previewing here and offers Retry; nothing about it disturbs an open draft or a running task.
 */
export function AppearanceSettings() {
  const { preferences } = useWorkspace();
  const status = usePreferencesStatus(preferences);
  const snapshot = usePreferenceGroup(preferences, "appearance");
  const stored = snapshot.data;
  const appearance = useMemo(() => normalizeAppearance(stored), [stored]);
  const mode = useEffectiveMode(appearance.mode);
  const themeMissing = !isThemeId(stored.themeId);
  const galleryId = useId();
  const accentId = useId();
  const brightnessId = useId();

  const update = (change: Partial<Appearance>) => {
    preferences.set("appearance", { ...appearance, ...change }, { immediate: true });
  };

  if (status === "loading" || status === "idle") {
    return (
      <div className="sym-settings">
        <h1 className="sym-settings-title">Appearance</h1>
        <SkeletonLines label="Loading your appearance" />
      </div>
    );
  }

  if (status === "error" && preferences.failure) {
    return (
      <div className="sym-settings">
        <h1 className="sym-settings-title">Appearance</h1>
        <InlineError
          {...loadFailureCopy(preferences.failure, "your appearance")}
          onRetry={() => preferences.load()}
        />
      </div>
    );
  }

  return (
    <div className="sym-settings">
      <div className="sym-settings-head">
        <h1 className="sym-settings-title">Appearance</h1>
        <SaveState />
      </div>
      <p className="sym-settings-intro">
        Style, accent and brightness are three separate choices. Changes show here at once and save
        to your account; your drafts and anything Simon is working on keep going.
      </p>

      {themeMissing ? (
        <p role="status" className="sym-settings-note">
          The style you had isn't available any more, so Symplist is showing Studio. Your accent and
          brightness are unchanged.
        </p>
      ) : null}

      <section className="sym-settings-section" aria-labelledby={galleryId}>
        <h2 id={galleryId} className="sym-settings-heading">
          Style
        </h2>
        <div className="sym-theme-gallery">
          {themeIds.map((themeId) => (
            <ThemeCard
              key={themeId}
              themeId={themeId}
              mode={mode}
              accent={appearance.accent}
              selected={appearance.themeId === themeId}
              onSelect={() => update({ themeId })}
            />
          ))}
        </div>
      </section>

      <section className="sym-settings-section" aria-labelledby={accentId}>
        <h2 id={accentId} className="sym-settings-heading">
          Accent color
        </h2>
        <div className="sym-accent-row" role="radiogroup" aria-labelledby={accentId}>
          {accentPresetIds.map((preset) => (
            <AccentSwatch
              key={preset}
              accent={preset}
              label={accentPresets[preset].label}
              themeId={appearance.themeId}
              mode={mode}
              selected={appearance.accent === preset}
              onSelect={() => update({ accent: preset })}
            />
          ))}
        </div>
        <CustomAccent
          appearance={appearance}
          mode={mode}
          onSelect={(accent) => update({ accent })}
        />
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={appearance.accent === DEFAULT_ACCENT}
          onClick={() => update({ accent: DEFAULT_ACCENT })}
        >
          Reset accent
        </Button>
      </section>

      <section className="sym-settings-section" aria-labelledby={brightnessId}>
        <h2 id={brightnessId} className="sym-settings-heading">
          Brightness
        </h2>
        <div className="sym-segmented" role="radiogroup" aria-labelledby={brightnessId}>
          {modePreferences.map((option) => (
            <label
              key={option}
              className="sym-segmented-item"
              data-selected={appearance.mode === option || undefined}
            >
              <input
                type="radio"
                className="sr-only"
                name="sym-brightness"
                value={option}
                checked={appearance.mode === option}
                onChange={() => update({ mode: option })}
              />
              {modeLabels[option]}
            </label>
          ))}
        </div>
        <p className="sym-settings-hint">
          System follows your device's brightness in the style you chose.
        </p>
      </section>

      <Button
        variant="secondary"
        size="md"
        className="self-start"
        onClick={() => preferences.set("appearance", DEFAULT_APPEARANCE, { immediate: true })}
      >
        Reset all appearance
      </Button>
    </div>
  );
}

function SaveState() {
  const { preferences } = useWorkspace();
  const snapshot = usePreferenceGroup(preferences, "appearance");
  if (snapshot.state === "saving") {
    return (
      <p role="status" className="sym-save-status">
        <Spinner size={11} />
        Saving…
      </p>
    );
  }
  if (snapshot.state === "previewing" && snapshot.failure) {
    return (
      <p role="status" className="sym-save-status" data-state="failed">
        {previewOnlyMessage(snapshot.failure)}{" "}
        <button
          type="button"
          className="sym-text-button"
          onClick={() => preferences.retry("appearance")}
        >
          Retry
        </button>
      </p>
    );
  }
  return (
    <p role="status" className="sym-save-status">
      Saved to your account
    </p>
  );
}

function ThemeCard({
  themeId,
  mode,
  accent,
  selected,
  onSelect,
}: {
  readonly themeId: ThemeId;
  readonly mode: ColorMode;
  readonly accent: AccentChoice;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const theme = themes[themeId];
  return (
    <label className="sym-theme-card" data-selected={selected || undefined}>
      <input
        type="radio"
        className="sr-only"
        name="sym-theme"
        value={themeId}
        checked={selected}
        onChange={onSelect}
      />
      <ThemeMiniature themeId={themeId} mode={mode} accent={accent} />
      <span className="sym-theme-card-foot">
        <span className="sym-theme-card-name">{theme.name}</span>
        <span className="sym-theme-card-state">
          {selected ? (
            <>
              <Check size={13} strokeWidth={2.6} aria-hidden="true" />
              Selected
            </>
          ) : (
            theme.tag
          )}
        </span>
      </span>
    </label>
  );
}

function AccentSwatch({
  accent,
  label,
  themeId,
  mode,
  selected,
  onSelect,
}: {
  readonly accent: AccentChoice;
  readonly label: string;
  readonly themeId: ThemeId;
  readonly mode: ColorMode;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const resolved = useResolvedAccent(themeId, mode, accent);
  return (
    <label className="sym-accent-swatch" data-selected={selected || undefined}>
      <input
        type="radio"
        className="sr-only"
        name="sym-accent"
        value={accent}
        checked={selected}
        onChange={onSelect}
      />
      <span
        aria-hidden="true"
        className="sym-accent-dot"
        style={{ background: resolved.accent, color: resolved.onAccent }}
      >
        {selected ? <Check size={12} strokeWidth={3} /> : null}
      </span>
      <span>{label}</span>
    </label>
  );
}

function CustomAccent({
  appearance,
  mode,
  onSelect,
}: {
  readonly appearance: Appearance;
  readonly mode: ColorMode;
  readonly onSelect: (accent: AccentChoice) => void;
}) {
  const custom = isAccentPresetId(appearance.accent) ? "" : appearance.accent;
  const [text, setText] = useState(custom);
  const [invalid, setInvalid] = useState(false);
  const fieldId = useId();
  useEffect(() => {
    setText(custom);
  }, [custom]);
  const preview = normalizeCustomAccent(text) ?? (custom || null);
  const resolved = useResolvedAccent(
    appearance.themeId,
    mode,
    (preview as AccentChoice | null) ?? appearance.accent,
  );

  const commit = (value: string) => {
    const normalized = normalizeCustomAccent(value);
    if (!normalized) {
      setInvalid(value.trim().length > 0);
      return;
    }
    setInvalid(false);
    onSelect(normalized);
  };

  return (
    <div className="sym-accent-custom">
      <label className="sym-field-label" htmlFor={fieldId}>
        Custom color
      </label>
      <div className="sym-accent-custom-row">
        <input
          id={fieldId}
          className="sym-search-input sym-accent-input"
          value={text}
          placeholder="#2F5FD0"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={`${fieldId}-help`}
          onChange={(event) => {
            setText(event.target.value);
            if (normalizeCustomAccent(event.target.value)) commit(event.target.value);
          }}
          onBlur={(event) => commit(event.target.value)}
        />
        <input
          type="color"
          className="sym-accent-picker"
          aria-label="Pick a custom accent color"
          value={normalizeCustomAccent(text) ?? accentSeed(appearance.accent)}
          onChange={(event) => commit(event.target.value)}
        />
        <span
          aria-hidden="true"
          className="sym-accent-dot"
          style={{ background: resolved.accent }}
        />
      </div>
      <p id={`${fieldId}-help`} className="sym-settings-hint">
        {invalid
          ? "Enter a color like #2F5FD0."
          : resolved.adjusted
            ? "Adjusted for readability: the rendered shade keeps your hue while staying legible on this style's surfaces."
            : "Six hex digits, for example #2F5FD0."}
      </p>
    </div>
  );
}
