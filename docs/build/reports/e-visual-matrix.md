# Phase E — populated workspace visual matrix

## Scope and decisions

Built from `519996a` in the isolated `wip/e-visual` worktree. This is the populated-list visual slice of Phase E, not completion of all Phase E flows.

- A fresh admitted account per frame uses the normal API to persist Maya Rao's profile, appearance, five tasks (three top-level, two nested), and a real encrypted Git-backed Markdown page. No intercepted endpoints, injected task markup or DOM theme overrides.
- Every comparison uses Violet and the same fictional content. Fonts finish loading before capture. Screenshots are unmodified browser PNGs, with animation disabled.
- At 1440 × 900 the portfolio task is selected and its saved page is visible alongside the populated inbox. At 1024 × 720 and 390 × 844 the collection is the primary surface, ensuring the actual populated list is visible rather than hidden behind a task page. This follows the responsive workspace brief; narrow task-page/chat states remain separate coverage.
- Existing mobile device scale factor 3 is retained: the mobile PNGs are 1170 × 2532 pixels representing a 390 × 844 CSS viewport.
- The first frame setup used programmatic focus only. Review strengthened it to assert a real ArrowDown transition to the first subtask, ArrowUp back to the named parent, and its visible solid focus outline.
- Comparison choices and contrast repairs are also recorded in append-only decisions EV.1–EV.2; no schema or feature contract changed.

## Findings and fixes

1. Unchecked task completion controls used decorative `--sym-line-strong`, insufficient to distinguish the control. The explicit browser contrast regression failed before repair (Tide Light: **1.86:1**, below 3:1). The boundary now uses the already contrast-adjusted `--sym-muted` token; hover/disabled behavior and geometry are unchanged. The same class covers the selected task header.
2. Tide Light's notification bell used page-muted color on its dark chrome (**1.80:1**). A narrowly scoped appended CSS block gives that top-bar control chrome-muted ink, chrome hover colors and the chrome focus accent. The regression failed independently after the checkbox repair, then passed after this fix.
3. No clipping, unintended horizontal page scroll, overlapping task controls, missing text, missing theme fonts or lost nesting was found in the inspected matrix. Paper's serif page, Pebble's rounded inset panels, Postcard's offset edges, Meadow's warm serif headings and Tide's deep chrome remain distinct. Selected markers and keyboard outlines remain separate.

All 36 final frames were opened and visually inspected. The audit includes task-title wrapping, nested indentation, profile/Vault placement, controls, selected/focused distinction, readable text and responsive composition. Axe is not claimed to establish complete WCAG compliance; explicit non-text contrast checks supplement it for the two repaired controls.

## Inspected evidence

All files are retained in `apps/e2e/evidence/visual-matrix/`. Each link below represents a separately inspected frame.

| Theme | Mode | 1440 desktop | 1024 laptop | 390 mobile |
| --- | --- | --- | --- | --- |
| studio | light | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--studio--light--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--studio--light--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--studio--light--mobile-390.png) |
| studio | dark | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--studio--dark--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--studio--dark--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--studio--dark--mobile-390.png) |
| paper | light | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--paper--light--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--paper--light--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--paper--light--mobile-390.png) |
| paper | dark | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--paper--dark--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--paper--dark--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--paper--dark--mobile-390.png) |
| pebble | light | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--pebble--light--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--pebble--light--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--pebble--light--mobile-390.png) |
| pebble | dark | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--pebble--dark--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--pebble--dark--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--pebble--dark--mobile-390.png) |
| postcard | light | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--postcard--light--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--postcard--light--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--postcard--light--mobile-390.png) |
| postcard | dark | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--postcard--dark--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--postcard--dark--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--postcard--dark--mobile-390.png) |
| meadow | light | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--meadow--light--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--meadow--light--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--meadow--light--mobile-390.png) |
| meadow | dark | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--meadow--dark--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--meadow--dark--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--meadow--dark--mobile-390.png) |
| tide | light | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--tide--light--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--tide--light--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--tide--light--mobile-390.png) |
| tide | dark | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--tide--dark--desktop-1440.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--tide--dark--laptop-1024.png) | [inspected](../../../apps/e2e/evidence/visual-matrix/workspace_now--populated--tide--dark--mobile-390.png) |

## Verification

- `pnpm install --frozen-lockfile`: passed, isolated dependencies.
- `pnpm lint`: passed, 1,286 files, zero warnings/errors.
- `pnpm typecheck`: all 17 projects passed.
- Scoped theme/shell tests: 461 passed across 7 files.
- Full web unit/component suite: 1,558 passed across 101 files.
- Full `pnpm test`: passed, 4,229 Vitest tests plus 47 script tests; 9 credential-gated live tests skipped, not claimed as live verification.
- Production Next build and API TypeScript build: passed as prerequisites of the browser run.
- Visual matrix: **36/36 browser tests passed**, with five real visible task rows, saved desktop page, persisted theme/mode, keyboard focus, no horizontal document overflow, checkbox/bell contrast ≥3:1, and WCAG 2.2 AA axe rules without exclusions.
- The two intentionally failing pre-fix contrast runs are regression evidence, not unexplained flakes.
- At this isolated branch checkpoint, full cross-feature e2e and live integration suites were not
  run; their later merged-tree results are recorded in [progress.md](../progress.md).
- Documentation links and all 44 screen briefs passed `python3 scripts/check_docs.py`; `git diff --check` passed.

Reproduce without disturbing the development instance:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
E2E_WEB_PORT=3400 E2E_API_PORT=4400 \
NEXT_PUBLIC_API_URL=http://127.0.0.1:4400 \
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:4400 \
pnpm --filter @symplist/e2e exec playwright test tests/visual-matrix.spec.ts --workers=1
```

## Exact shared paths and integration notes

- `apps/e2e/tests/visual-matrix.spec.ts` — new real-API matrix and visual/a11y regressions.
- `apps/e2e/evidence/visual-matrix/` — 36 new PNGs linked above; no previous evidence overwritten.
- `apps/web/src/features/workspace/workspace.css` — one checkbox border-token change.
- `apps/web/src/app/globals.css` — one clearly commented appended block targeting only the top-bar notification control.
- `docs/build/reports/e-visual-matrix.md` — this report.
- `docs/build/decisions.md` — appended EV.1–EV.2 only.

No migrations, manifests, lockfile, backend, Simon/Connections components, progress ledger or coverage ledger changed. No live credentials were read or retained; the existing harness generated throwaway test keys and local-driver accounts. Ports 3000/4000 were untouched.

The captured Simon panel is the baseline's truthful empty state. Dedicated Studio/light Simon,
approval and Quick Chat evidence at all three viewports is recorded in
[the Simon browser report](e-simon-browser.md); it is intentionally separate from this 36-frame
populated-workspace theme matrix. Consent was disabled by the throwaway test deployment, so these
frames do not verify the consent banner; the merged analytics browser journey does.
