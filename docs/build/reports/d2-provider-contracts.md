# D2 provider contract stream

## Scope

Added reusable suites under `packages/testing/src/contracts/` for the Simon AI provider boundary and
the Composio connection wrapper. Package-level runners exercise the scripted model and fake Composio
client on every run. Live suites are visibly skipped unless `LIVE_OPENAI=1` or `LIVE_COMPOSIO=1` and
the corresponding credential is present.

The OpenAI probe sends only a short synthetic marker, caps output, disables AI SDK telemetry and
retries at the call boundary, and never supplies tools. The Composio live probe lists bounded toolkit
metadata only; it never creates a session, selects an account, or executes a connector action.

## Contract coverage

- AI: bounded generate/stream output, stable provider/model identity, no provider-executed tools,
  disabled telemetry/retries, visible live skip reasons, and console marker non-disclosure.
- Composio: explicit discovery/schema bounds, recursive identity stripping, trusted account
  injection, raw no-retry side-effect execution, forged-action/schema rejection, normalized
  rate-limit errors, and log marker non-disclosure.

## Decisions and seams

- No package dependency or runtime configuration change was necessary; the contracts are exported
  from `@symplist/testing`.
- Live probes are opt-in and content-free by construction. Missing flags/credentials are skipped,
  never treated as passing live evidence.
- No PostHog or analytics scope was added.

## Verification

Biome formatting/lint and `git diff --check` pass for all changed files. Full Vitest/typecheck runs
were not available in this isolated worktree because the local pnpm install is absent and the
launcher attempted to hydrate `pnpm@12.4.2` from the network; no live provider credentials were
used.
