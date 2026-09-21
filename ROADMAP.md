# Roadmap

## Shipped

The initial specification is fully implemented and verified:

1. **Foundation** — Next.js/NestJS setup, direct D1/R2 contracts, encryption, OTP, explicit beta admission, administrator bootstrap.
2. **Workspace** — tasks/subtasks, page/chat layout, all six themes with independent accents, responsive and keyboard interactions.
3. **Documents** — actual Git publication/recovery, section tools, history/restore, encrypted search.
4. **Simon** — bounded facilitation, Composio wrappers, scoped incoming MCP, approvals, Nest/Trigger executor parity and reconnects.
5. **Sharing** — specialist handoffs, artifact snapshots, reviewed grants, password/public variants, standalone read-only views.
6. **Time** — deadlines, calendar, quiet hours, notifications, Resend reminders, durable/local job recovery.
7. **Release readiness** — Vault/recovery, administrative and failure states, optional PostHog analytics, privacy checks, accessibility, self-hosting, backup/restore, and deployment guides.

Every item above passed the full release gate: lint, typecheck, 4,800+ automated tests, production builds, 212 browser cases across three viewports, and the local smoke and deployment checks. Acceptance is defined in [the numbered notes](docs/notes/files/00_index.md); no claim in the README ships without implementation, tests, and documented setup behind it.

## Possible next steps

Nothing here is promised or scheduled; proposals are welcome via issues:

- **Resend live-delivery verification** — the delivery/webhook path is verified locally; a live-provider confirmation run remains open.
- **AWS portability** — moving the API off its initial Render host without changing contracts.
- **Billing and plans** — deliberately out of scope for the beta; would require its own specification and privacy review first.
- **Additional AI providers** — beyond the configured OpenAI/Vertex/Together paths, behind the existing provider contract tests.
- **Additional Composio connections** — expanding the catalogue within the existing wrapper and approval model.

## How changes are proposed

Open a focused issue describing the problem and the affected contract (notes, migration, or package). Large architecture changes must explain their impact on the agreed scope; see [CONTRIBUTING.md](CONTRIBUTING.md).
