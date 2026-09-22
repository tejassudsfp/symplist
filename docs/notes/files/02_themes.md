# Themes and appearance

Confirmed requirement: users choose a complete visual theme in Settings. Every theme includes deliberately designed light and dark variants. Theme/style, accent color, and brightness mode are three independent preferences.

This is a product and implementation specification; no theme UI or assets have been built yet.

## Settings experience

Settings → Appearance presents a small gallery of named themes with representative workspace previews. Choose a theme/style, an accent color, and Light, Dark, or System independently. System follows the device's brightness preference within the selected theme; it does not choose a different theme.

Preview changes immediately and persist the selection. Show the task list, document, and chat in previews so the choice communicates design differences beyond a color swatch. Theme controls belong in settings, with no mandatory choice during onboarding.

All bundled themes are available to unlocked beta users. Appearance does not introduce a paid tier.

## What a theme controls

- Neutral surface palettes, surface hierarchy, and light/dark contrast; accent color is a separate user preference.
- UI and document typography: font families, sizes, weights, and line heights.
- Spacing, density, reading width, and row/component proportions.
- Borders, corner shapes, shadows, and restrained decorative surfaces.
- Task rows, selected states, buttons, menus, inputs, chat messages, code blocks, and document heading treatments.
- Panel framing and visual grouping: for example, continuous flat panels versus inset cards.
- Motion style where appropriate, always honoring reduced-motion preferences.

The icon rail → task inbox → document → chat organization, task semantics, keyboard access, and available actions remain consistent. Visual treatments can differ substantially without changing how tasks work. Switching appearance must not remount the editor/chat, discard drafts, reset scroll unnecessarily, or interrupt an active agent run.

## Proposed initial directions

Names and styles below are proposals, not selected final designs.

| Theme | Design character | Light treatment | Dark treatment |
| --- | --- | --- | --- |
| Studio | Precise sans-serif typography, flat panels, fine dividers, compact controls | Crisp neutral surfaces | Layered charcoal surfaces |
| Paper | Serif document headings, generous reading space, inset document sheet, quiet controls | Warm paper and ink | Warm dark surfaces with pale text |
| Pebble | Rounded panels, roomier rows, pill-shaped controls, gentle elevation; subtly playful | Airy muted mineral surfaces | Rounded deep mineral surfaces |
| Postcard | Firmer outlines, quiet offset shadows, a small tab detail; subtly playful | Off-white stationery with one restrained accent | Deep blue-gray surfaces and quiet light outlines |

Deliver a few cohesive themes rather than an extensive customization panel. Both modes of a theme must preserve its identity; dark mode is not a mechanical color inversion.

## Implementation direction

Use a versioned theme registry with semantic tokens for colors, fonts, spacing, borders, radius, shadows, and motion. Add bounded component appearance variants where tokens alone cannot express a theme, such as inset document framing or chat message grouping. Share behavior and accessibility primitives across themes instead of duplicating whole applications.

Store user preferences as `themeId`, `accent` (preset ID or validated custom sRGB hex), and `colorMode` (`light`, `dark`, `system`) through the normal authorized preferences API and encrypted storage path. Keep derived mode and theme defaults separate from user data. If a theme is removed, fall back to the default theme while preserving the user's accent and brightness preferences.

Apply the selection before rendering the workspace to avoid a flash of the wrong theme. If a minimal browser bootstrap preference is needed, explicitly treat it as nonsensitive local display configuration; do not place account data or secrets in it. Reset account-scoped preferences appropriately when users switch accounts.

Bundle/self-host licensed fonts and theme assets where practical. Every self-hosted deployment includes the themes without proprietary asset or hosted-service dependencies. Contributed themes must satisfy the same light/dark and accessibility contracts. Arbitrary remote CSS/scripts are outside the initial scope.

Theme styling covers the app shell, settings, dialogs, vault, archive, editor, and chat consistently. Syntax highlighting, Markdown tables, tool results, drag targets, loading/error states, and focus indicators also need paired light/dark styles.

## Verification before release

Check every theme in both modes, system-mode changes, keyboard focus, readable contrast, reduced motion, narrow screens, long task names, deep sublists, and enlarged text. Switch themes during an unsaved document edit and active chat run to verify state preservation. Verify persistence across refresh/login, account isolation, missing-theme fallback, and layout behavior when fonts are unavailable.

Studio and Paper provide familiar professional styles; Pebble and Postcard add restrained personality. Each has intentionally designed light/dark variants.

## Independent accent color

Confirmed: Studio, Paper, Pebble, and Postcard can each use the user's chosen color. Theme changes preserve the accent; accent changes preserve typography, geometry, density, panel framing, and brightness. Blue Studio and purple Pebble are examples, not fixed pairings. Use one global default accent for new accounts; theme descriptions' colors are illustrative suggestions only.

Offer a compact named palette (Blue, Violet, Rose, Coral, Amber, Green, Teal, Graphite) and Custom with an accessible color picker and hex input. Avoid a large appearance dashboard. Preview immediately in a real task row, primary action, link, focus ring, and chat control. Persist all three preferences together through the authorized preferences API; rapid changes must not allow an older save response to overwrite a newer selection. Reset appearance explicitly resets all three; resetting just accent changes only that field.

The stored accent is a seed, not raw paint applied everywhere. Derive light/dark semantic accent tokens for solid fill, on-accent text, subtle tint, border, link, selection, hover, and focus against each theme's surfaces. Preserve the chosen hue where feasible while adjusting lightness/chroma for readable contrast. Show the resolved swatch alongside the input and explain when readability changes the rendered shade. White, black, saturated, and pale custom choices must remain usable. Use a neutral fallback when needed; never accept arbitrary CSS as a color.

Accent primarily marks interaction and selection. Success, error, warning, and overdue states keep independent semantic tokens and text/icons; choosing red must not make every normal action mean danger. Document content and syntax highlighting retain their own legible palettes. Focus must remain distinguishable from selected state. Validate normal text at 4.5:1, large text and relevant UI boundaries at 3:1, including hover/focus states; color never carries status alone.

Require theme × accent × mode component checks for all bundled presets, plus custom-color extremes. Preview the same accent across all four styles, and multiple accents within one unchanged style. Switching any appearance preference during typing, chat streaming, or calendar editing must preserve work. Honor account isolation and fallback semantics already specified above.
