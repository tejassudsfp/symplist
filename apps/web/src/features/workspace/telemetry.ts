import type { AnalyticsEventProperties } from "@symplist/analytics";
import type { PreferenceDataByGroup } from "@symplist/contracts";
import { isAccentPresetId } from "@/theme/accent";
import { normalizeAppearance } from "@/theme/appearance";

let reporter: ((properties: AnalyticsEventProperties<"appearance_changed">) => void) | null = null;
export function setAppearanceReporter(value: typeof reporter): void {
  reporter = value;
}
export function reportSavedAppearance(
  before: PreferenceDataByGroup["appearance"],
  after: PreferenceDataByGroup["appearance"],
): void {
  const previous = normalizeAppearance(before);
  const current = normalizeAppearance(after);
  for (const [key, changed] of [
    ["themeId", "theme"],
    ["accent", "accent"],
    ["mode", "mode"],
  ] as const) {
    if (previous[key] === current[key]) continue;
    try {
      reporter?.({
        changed,
        theme: current.themeId,
        accent: isAccentPresetId(current.accent) ? "preset" : "custom",
        mode: current.mode,
      });
    } catch {
      /* Product actions never depend on telemetry. */
    }
  }
}
