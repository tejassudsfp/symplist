# Roadmap

## Shipped

The initial specification is fully implemented and verified:

1. **Foundation** — Next.js/NestJS setup, direct D1/R2 contracts, encryption, OTP, explicit beta admission, administrator bootstrap.
2. **Workspace** — tasks/subtasks, the task page, all six themes with independent accents, responsive and keyboard interactions.
3. **Documents** — actual Git publication/recovery, section tools, history/restore, encrypted search.
4. **Labels** — encrypted names, a colour from the accent palette, chips on the task and a filter above each list.
5. **The assistant interface** — scoped incoming MCP with OAuth dynamic client registration, a consent screen, per-grant task scoping and revocation.
6. **Sharing** — specialist handoffs, artifact snapshots, reviewed grants, password/public variants, standalone read-only views.
7. **Time** — deadlines, calendar, quiet hours, notifications, Resend reminders, durable/local job recovery.
8. **Release readiness** — Vault/recovery, administrative and failure states, optional PostHog analytics, privacy checks, accessibility, self-hosting, backup/restore, and deployment guides.
9. **Desktop shell** — the same frontend in an Electron window, with the cloud session held out of the renderer.

Every item above passed the full release gate: lint, typecheck, 4,300+ automated tests, production builds, browser cases across three viewports, and the local smoke and deployment checks. Acceptance is defined in [the numbered notes](docs/notes/files/00_index.md); no claim in the README ships without implementation, tests, and documented setup behind it.

## Removed, deliberately

Three features were built, shipped and then deleted. Each is recorded rather than quietly dropped, because the reasoning is the useful part:

- **The server-side assistant** — the agent loop, chat, approvals, run authority and model credentials. See [note 18](docs/notes/files/18_local_first_desktop.md).
- **The embedded desktop assistant** — a vendored harness over ACP, removed after it proved strictly less capable than the MCP client people already had open, and after it required pasting a provider key into our window.
- **The connector layer** — the Composio wrappers and their approval model, whose executor had been dead code since the server-side assistant left.
- **Offline local mode** — specified in note 18 and half built (declared deployment, single owner, local drivers). Deleted before it shipped: a second production topology is a permanent correctness cost, and nobody had asked for it.

Their tables remain, because migrations here are expand-only, and are no longer written.

## Next

- **Signed and notarized desktop builds** — the DMG is currently unsigned, so macOS reports it as damaged. This is what stands between the desktop app and a stranger installing it.

## Possible next steps

Nothing here is promised or scheduled; proposals are welcome via issues:

- **Resend live-delivery verification** — the delivery/webhook path is verified locally; a live-provider confirmation run remains open.
- **AWS portability** — moving the API off its initial Render host without changing contracts.
- **Billing and plans** — deliberately out of scope for the beta; would require its own specification and privacy review first.

## How changes are proposed

Open a focused issue describing the problem and the affected contract (notes, migration, or package). Large architecture changes must explain their impact on the agreed scope; see [CONTRIBUTING.md](CONTRIBUTING.md).
