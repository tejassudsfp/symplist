# D2 integration audit

Integrator: `feat/symplist-build`. No pushes or live migrations. Branch implementations remain subject to combined verification and the listed cross-feature seams.

## Vault — `f881976`

- Merged with `--no-ff`, after Simon checkpoint `09960ab`; no conflict resolution required.
- Compared every one of the 54 branch-changed paths against the merged working tree: 50 are byte-identical, including the two intentionally removed access-only OTP files whose contents moved to shared infrastructure.
- Four differences are intentional integrator additions: `internal.test.ts` and `platform.test.ts` preserve the new Simon synthetic-topic overrides; `decisions.md` preserves all Vault rows plus newer Simon rulings; `progress.md` preserves newer root checkpoints and current phase status. No Vault implementation line was discarded.
- All 17 typechecks pass. Focused Vault/Search core tests: 49 passed; Vault HTTP: 10 passed.
- Still required: Simon picker/resolver wiring, hourly cleanup wiring, canonical lock frame before shared logout/restriction socket closure, combined browser/visual/live checks.

## Scheduling and Resend — `1792f5f`

- Merged sequentially with `--no-ff`. Resolved only the shell placeholder test and appended CSS: both Vault and Scheduling controls/assertions and complete feature blocks remain.
- Audited all 81 branch-changed paths: 73 byte-identical. The eight differences retain newer Simon topic fixtures/regressions (three tests), Vault shell assertions/CSS, union decisions, root progress, and root lockfile entries for pnpm/agent crypto tests. No scheduling implementation was discarded.
- Combined lint exposed descending specificity from Vault list buttons before calendar buttons. Using `:where(li)` keeps the same matching elements without unnecessary ancestor specificity; selected-state styling remains stronger. This is the only integration CSS adjustment beyond concatenating complete blocks.
- Frozen install, all 17 typechecks, 52 scheduling core tests, 14 scheduling/Resend HTTP tests and 29 scheduling/shell UI tests pass.
- Still required: native Simon tool registration, cleanup callbacks, consent-gated reminder analytics, combined browser/live/load/visual evidence.
