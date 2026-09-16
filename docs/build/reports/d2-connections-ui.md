# D2 Connections UI

Branch: `wip/d2-connections-ui`, isolated worktree `../symplist-wt/connections-ui`, based on
`131818d`. The backend author's contracts-only `1322884` is cherry-picked as `bdf18b7`.
No backend implementation, migration, secret or environment file is changed.

## Implemented

- Service Connections settings: live on-demand catalogue/search, connected and disconnected
  accounts, health, account labels, hosted authorization, explicit reconnect and disconnect,
  confirmed/cancelled/failed callback states, retryable failures and keyboard focus restoration.
- Optional onboarding uses the same real catalogue with at most four initial examples; the
  existing Continue, Skip and Back controls remain independent of connector state. Disabled
  deployments show neutral copy. Full-page authorization avoids popup blockers entirely.
- Agent Connections: configured MCP address, scoped API-key creation, deliberate broad scope,
  independent permissions, paginated active-task selection, grant metadata/health, revoke
  confirmation, masked one-time reveal/copy, lost-response replay and revoke-and-replace.
- Owner/session-bound OAuth consent, unverified-client/provenance/loopback warnings, requested
  permissions and offline-access explanation, explicit task scope, expiration, deny/allow,
  one-time redirect handling, and fixed-API-origin authorization bridge after sign-in.
- Epoch-fenced in-memory resources, StrictMode reopen, single-flight/coalesced refresh, abort and
  late-response rejection; exact input/key mutation retry. No catalogue or credential persistence.
- Command-palette navigation actions, semantic theme tokens, responsive full-height mobile
  details, accessible labels and genuine confirmation dialogs.

## Decisions

Recorded append-only as `D2UI.1`–`D2UI.3` in decisions.md. Provider authorization is a full
navigation, never an imitation login form or popup. Only validated task/collection ids survive
the fixed callback in owner-and-generation-scoped session storage; no credential, arbitrary URL
or catalogue is stored. Task-scoped grant choices do not implicitly include descendants.

## Exported seams

- `ServiceConnections({ compact? })`: settings surface or onboarding catalogue slot.
- `AgentConnections`: scoped agent-key management screen.
- `OAuthConsent` and `OAuthAuthorizeBridge`: excluded route-group screens.
- `ConnectionsProvider`, `ConnectionsEnvironment`, `ConnectionsApi`, `createConnectionsApi`:
  transport/navigation/realtime injection; production defaults use the shared cookie/CSRF client.
- `TaskScope`, `Permissions`: the same choices for keys and OAuth consent.
- `connectionsActions`: unbound palette routes for service and agent connections.
- Simon may link to `/settings/connections?task=<UUIDv7>&collection=now|later|unclassified`;
  returning never approves or resumes a pending action automatically.

## Shared files outside the feature directory

- `apps/web/src/app/(app)/settings/connections/page.tsx`
- `apps/web/src/app/(app)/settings/agents/page.tsx`
- `apps/web/src/app/(onboarding)/welcome/connections/page.tsx`
- `apps/web/src/app/(consent)/oauth/consent/page.tsx`
- `apps/web/src/app/(consent)/oauth/authorize/page.tsx` (new)
- `apps/web/src/app/globals.css`: exactly one appended Connections block; existing CSS untouched.
- `apps/web/src/features/access/navigation.ts` and `session.tsx`: preserve only the allowlisted
  callback outcome when the app gate resumes the optional connections onboarding step.
- `docs/build/decisions.md`: two appended rulings only.
- `docs/build/reports/d2-connections-ui.md`: this report.
- Contracts-only cherry-pick: `packages/contracts/src/connections/oauth.ts` and
  `packages/contracts/src/index.ts`, identical to the backend author's commit.

## Verification

- Frozen install passed in this isolated worktree; no shared node_modules link.
- Repository lint: 1,212 files, zero errors/warnings; repository-wide typecheck passed.
- Focused web contracts/component/lifecycle tests: 9 files / 68 tests passed; the combined
  Connections/access-navigation/session regression pass also passed, 11 files / 93 tests.
- Full web suite: 98 files / 1,552 tests passed.
- Production web build passed, including both OAuth routes and both settings screens.
- Local Markdown links and all 44 screen briefs passed the docs check; `git diff --check` passed.
- The branch diff was reviewed for authority boundaries, CSRF, lost-response retry, stale effects,
  bounded fetching, credential persistence, focus, and loading/error states. Review fixes are below.
- Browser/e2e and visual evidence were not run concurrently with the integrator. No live-provider
  authorization or external account mutation was performed; those belong to combined Phase E.

## Review fixes

- Missing public API configuration could throw synchronously out of an effect; resources now
  convert synchronous failures into a retryable load state.
- Non-idempotent UI retries now retain the original request/key after uncertain outcomes;
  definitive validation refusals reopen editing instead of trapping the form.
- Nested disconnect/replacement failures are shown inside the active confirmation, not behind it.
- Explicit accessible names distinguish account buttons without depending on hidden text layout.
- Component state remounts on account/access-generation changes, removing a displayed key at once.
- Full task-page selection avoids the original first-page-only trap; fetching remains user-driven.
- The app gate used to discard cancelled/failed callback outcomes on onboarding return. It now
  preserves only that allowlisted enum for the exact Connections-to-onboarding transition, with
  real gate regression tests and no propagation of arbitrary callback query data.

## Integration follow-up

Merge after the Connections backend contract/checkpoint. Run the combined browser journey for
hosted callback, onboarding return, key setup/revoke and OAuth consent, including mobile and all
theme/mode evidence. The UI is implemented against real contracts; tests use provider-shaped
fakes and the real browser API client, not live external credentials.
