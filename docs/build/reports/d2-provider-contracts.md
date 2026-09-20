# D2 provider contract stream

Status: merged; fake/scripted contracts and the bounded live OpenAI and Composio targets have run.

## Scope

Added reusable suites under `packages/testing/src/contracts/` for the Simon AI provider boundary and
the Composio connection wrapper. Package-level runners exercise the scripted model and fake Composio
client on every run. Live suites are visibly skipped unless `LIVE_OPENAI=1` or `LIVE_COMPOSIO=1` and
the corresponding credential is present.

The OpenAI probe sends only a short synthetic marker, caps output, disables AI SDK telemetry and
retries at the call boundary, and never supplies tools. The Composio live probe lists bounded toolkit
metadata only; it never creates a session, selects an account, or executes a connector action.
Credential gates remain visible for ordinary offline runs; the live results below were produced by
explicitly enabling the targets with the ignored environment.

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

The original isolated implementation checkpoint passed Biome and `git diff --check`; later merged
package and repository gates superseded its missing-install caveat. On 2026-09-20 the credentialed
targets produced:

- OpenAI: **12/12 passed**.
- Composio: **7 passed / 5 intentionally skipped target-capability cases**. The bounded live
  catalogue probe passed; the skips are cases whose fake target exposes controls the live metadata
  target deliberately does not.

These are content-free provider-boundary probes. They do not establish a live connected-account
mutation or an end-to-end browser → Trigger `simon-run` → encrypted output-relay journey.
