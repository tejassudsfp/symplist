# D2 parallel ownership

The owner's latest instruction authorizes isolated worktrees, superseding the earlier single-checkout instruction. One writer owns each worktree; no writer edits another tree. The integration branch remains `feat/symplist-build`. Nothing is pushed.

| Stream | Owner / worktree | Scope | Migration allocation |
| --- | --- | --- | --- |
| A | Integrator / `symplist` | Simon, executors, quick chat, final integration and Phase E | 0502–0599 (0500–0501 already exist) |
| B | Vault / `symplist-wt/vault` | Architecture §11 and all five Vault screens | 0700–0799 |
| C | Scheduling / `symplist-wt/scheduling` | Architecture §12, notifications, calendar, Resend webhook | 0600–0699 |
| D | Sharing / `symplist-wt/sharing` | Architecture §13 and §15, sharing/handoff, analytics/consent | 0800–0899 and 1000–1099 |
| E | Connections / `symplist-wt/connections` | Architecture §14, Composio wrappers and incoming MCP | 0901–0999 (0900 already exists) |

The suggested 0300–0499 allocations collide with existing Documents/Search ownership and files. Architecture §3.4 and the migration README already reserve independent D2 ranges; preserve those. Migrations remain expand-only and existing migrations are immutable.

Vault finished its implementation/review checkpoints at `f881976` with a clean worktree and passing branch gates; it remains unmerged with browser verification and shared integration hooks pending. Connections started from `8e26f4f` in the freed slot. No agent writes the completed Vault tree.

## Shared-file rules

- Each stream appends exactly one clearly labelled feature block to `apps/web/src/app/globals.css`; never reorder existing CSS.
- Decisions are append-only. Use `D2V.*`, `D2C.*`, `D2D.*`, and `D2E.*` decision identifiers for independent streams; Simon keeps `SI*`.
- Contract schemas import `z` only through `common/zod.ts`.
- Each stream writes `docs/build/reports/d2-<stream>.md`: implementation, decisions, actual verification, adversarial review fixes, unresolved seams, and every touched file outside its feature directories. Do not claim a gate passed if it was not run.
- The integrator owns updates to `progress.md` and `coverage.md`, incorporating those reports after merges. Workers do not edit these two shared ledgers.
- Runtime/module registries, contracts exports, configuration, package manifests and shell mounts may need independent edits. Report every overlap; preserve all contributions during integration.
- Export clean seams: Vault grants/resolution; scheduling tool operations; sharing proposals separate from trusted-UI token release; analytics allowlisted capture; Connections confirmed-account/tool access. Do not implement a parallel Simon loop.
- No simultaneous e2e runs. Workers build unit/contract/UI tests and browser specs; the integrator runs combined browser gates after merging. Worker-local builds use their own dependencies and output directories.

## Landing and verification

Checkpoint Simon first. Merge each completed stream separately with `--no-ff`, refresh dependencies if needed, and typecheck between merges. Review each stream's diff against the merged tree and account for every missing or changed line, including CSS and registry contributions. A merge is not completion: run the full integration gates, cross-feature contracts, secret scans, load checks, and Phase E journeys afterwards. Independently inspect the whole feature diff adversarially before declaring it ready.
