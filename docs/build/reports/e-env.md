# Phase E environment distribution

Status: merged and verified against the ignored live runtime files on 2026-09-20.

## Outcome

`pnpm env:distribute` reads the private root `.env.local`, derives each destination from its
checked-in app template and the binding secret inventory, validates all three runtime schemas in
memory, then atomically writes:

- `apps/api/.env`
- `apps/worker/.env`
- `apps/web/.env`

Every output is mode 600. `pnpm env:check` re-reads those ignored files and verifies their modes,
owned variable sets, forbidden-secret placement, full runtime schemas and the exact shared versions
and values of `CONTENT_KEK`, `INTERNAL_EVENT_SECRET` and `REMINDER_UNSUBSCRIBE_SECRET`. Neither
command prints values.

The splitter retains every configured rotation version. With `DURABLE=true`, the api excludes AI
provider credentials; the worker excludes `TRIGGER_SECRET_KEY`, both D1 tokens that do not belong to
it, all webhook/api-only credentials and all nine api-only generated families. The web receives only
its documented public/build variables.

## Verification

- Eight built-in script tests pass: durable and local executor placement, family rotation,
  round-trip dotenv serialization, platform-injected Trigger exclusion, unknown-variable refusal,
  unowned-source refusal, validate-before-write behavior, shared-family equality and error-message
  canaries.
- 225 focused `packages/config` tests pass.
- Biome checks all 1,308 files with zero errors or warnings.
- The documentation check passes for all 44 screen briefs.
- On 2026-09-20 the integrated `pnpm env:check` passed against the actual ignored outputs: 82 API,
  55 worker and five web assignments, with all three files mode 600. The earlier branch-time
  `AI_PROVIDER_MODE` source correction is no longer pending. No value appeared in output.
- The same live checkpoint ran the migrator against D1. It reported `applied: 0`,
  `alreadyApplied: 45`, `outOfOrder: 0`; all 45 current expand-only migrations were already present.

Environment verification establishes placement, schema validity, shared-family equality and file
permissions. It does not establish application startup, browser behavior or a complete deployment
gate on the current merged head.

## Shared files touched

- `.env.example`: corrects the obsolete claim that all twelve generated families are shared and
  documents the commands.
- `package.json`: adds `env:distribute` and `env:check`.
- `docs/build/decisions.md`: decision ENV1.
- `docs/build/progress.md` and `docs/build/coverage.md`: truthful Phase E checkpoint/evidence.
