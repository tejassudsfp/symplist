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

## Sharing and Analytics — `e2b61f0`

- Sequential `--no-ff` merge. Preserved all three appended feature CSS blocks and all implemented shell-slot assertions; only quick chat and command-palette slots remain empty in that fixture.
- Audited all 77 branch-changed paths: 69 byte-identical. The eight differences are the two newer Simon topic fixtures, combined shell/CSS, union decisions/root progress, the stronger analytics queue synchronization regression, and merged Temporal/agent-crypto lockfile entries.
- Combined styles exposed unnecessary calendar header/state specificity ahead of unrelated sharing/consent selectors. `:where(header)` and `:where([data-completed])` retain identical matches and ordering, without the extra specificity; no declarations or feature block was dropped.
- Frozen install and all 17 typechecks pass. Focused verification: 9 core, 20 HTTP, 31 sharing/consent/shell UI and 105 analytics wrapper tests pass. Combined lint: 1,259 files, zero errors/warnings.
- Still required: Simon native tools/handoff callback, worker grant-event relay, hourly maintenance wiring, server lifecycle analytics, combined browser/visual/live evidence.

## Combined browser pass

- Full unit/contract/script suite, both builds, local smoke, deploy completeness/boot (40 migrations), docs and lint pass after all three merges.
- First browser run found four consistent failures across all viewports, not random contention: checkbox touch targets, obsolete pre-D2 tab sequence, ambiguous search/consent retry locator, and a misspelled Vault test CSRF header. Fixed all four without dropping assertions; final full run is 107 passed / 19 unchanged viewport skips.
- New real-API Vault recovery, scheduling/calendar/settings and sharing/viewer/revocation journeys pass on all three viewports. Vault theme frames currently exist only in run attachments; comprehensive retained visual review remains pending.
