# Settings — style, accent, and brightness

Read [overall.md](overall.md) and [themes.md](themes.md) first. Produce high-fidelity mockups for this surface and the states below. Closed-beta rules apply throughout.

## Screen and interaction brief

Design the full Appearance settings experience from themes.md. Show four theme preview cards: Studio, Paper, Pebble, Postcard. Each miniature preview includes list/document/chat framing and actual typography, so users see structural differences. A color palette alone is not sufficient.

Provide an independent accent palette with named swatches and a Custom color picker/hex field, plus a separate Light / Dark / System segmented choice with readable labels. System follows device brightness for the currently selected theme. Make the selected theme unmistakable through a label/check and outline, not color alone. All options are available during beta; no locks or paid badges.

Changes preview immediately and save automatically. Show selected/hover/focus, saving, saved, persistence failure with retry, unavailable theme fallback, and a system preference change. A save failure should distinguish “Previewing here” from “Saved to your account.” Keep custom CSS, dozens of accent sliders, and font marketplaces out of scope; a simple custom accent picker is in scope.

Show the transition while a task draft and agent run remain active behind/alongside settings; annotate that appearance changes preserve work. Use no animation that reflows the whole workspace unnecessarily.

Desktop: comfortable gallery within the settings content area. Mobile: one or two cards per row with readable previews, no tiny eight-option theme grid. Render this screen in every theme/mode pairing and use the same content for comparison.

## Handoff

Use the frame naming and theme coverage in overall.md. Annotate entry/exit, primary and secondary actions, focus behavior, responsive changes, and persistence expectations. Include meaningful error/loading states rather than only the successful screen. Reuse shared components; do not add unrequested billing or automation features.

## Accent interaction frames

Show three clearly labeled groups: Theme/style, Accent color, and Brightness. Demonstrate Pebble + Violet, Studio + Violet, and Studio + Green; this proves that color and structure change independently. Theme previews use the currently selected accent rather than implying bundled fixed colors. Mark selected swatches with a check and accessible name, never color alone. Include preset keyboard navigation, custom hex validation, adjusted-for-contrast preview, custom light/dark examples, rapid-save ordering, retry, reset-accent, and reset-all states. Match the semantic-token and accessibility contract in [appearance notes](../../docs/notes/files/02_themes.md).
