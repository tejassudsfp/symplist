# Phase E environment distribution

Status: implemented and verified locally on `wip/e-env`; pending merge and one ignored source-file
correction.

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
- A live-shaped distribution from the ignored owner source produced and re-validated 82 api, 55
  worker and five web assignments, all mode 600. No value appeared in output.

The live-shaped first pass stopped before writing because the ignored master source carries an
obsolete `AI_PROVIDER_MODE`. An isolated private copy was set to the binding production value
`live`, after which distribution and `env:check` passed. The branch deliberately did not modify the
main checkout's ignored source. Integration must make that one non-secret correction before running
the command there.

## Shared files touched

- `.env.example`: corrects the obsolete claim that all twelve generated families are shared and
  documents the commands.
- `package.json`: adds `env:distribute` and `env:check`.
- `docs/build/decisions.md`: decision ENV1.
- `docs/build/progress.md` and `docs/build/coverage.md`: truthful Phase E checkpoint/evidence.
