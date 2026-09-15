# Symplist UI sample

User-supplied visual reference, copied unchanged from `Downloads/Symplist UI mockups` on September 15, 2026.

- [workspace_now.dc.html](workspace_now.dc.html): main workspace design export, including theme, viewport, state, and handoff controls.
- `support.js`: companion runtime referenced by the export; keep beside the HTML.
- `.thumbnail`: original preview asset, preserved with the export.

The user selected this sample as the visual foundation for the application. Derive the remaining screens from its typography, geometry, spacing, surfaces, and component language. Missing screens are specified in [the screen briefs](../mockups/overall.md); absence from the sample does not remove them from scope.

Inspect the rendered sample during implementation. Source inspection alone does not establish visual fidelity. The export includes design-review frame chrome that is explicitly not product UI. Do not ship its review controls or assume its supporting script is the production application framework. It also references Google Fonts; the application should follow the self-hosted/licensed font requirements in the theme notes.

Preserve these originals as reference assets. Implement reusable Next.js components and semantic theme tokens separately. Confirm independent style, accent, and Light/Dark/System choices even if an exported state demonstrates only fixed pairings. Current product/security requirements override incidental demo behavior; this sample takes precedence over generic visual suggestions when choosing the visual treatment.
