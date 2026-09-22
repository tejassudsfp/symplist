# Symplist

**The most productive thing is often the most simple.**

A calm, open-source task workspace. Every task has one editable Markdown page with real Git history and one persistent conversation with **Simon**, a built-in AI facilitator. Keep the surface simple; open deeper features only when you need them.

[Quickstart](#run-locally) · [Self-hosting guide](SELF_HOSTING.md) · [Product specification](docs/notes/files/01_product.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

## What you get

- **A focused workspace** — Now / Later / Unclassified inboxes, subtasks, drag-and-drop and keyboard movement, archive/restore, and responsive page/chat panels.
- **Documents with real history** — Markdown backed by an actual Git engine, encrypted artifacts in object storage, indexed publication in D1, and section-level AI tools that never paste a whole document into a prompt.
- **Simon, a productivity facilitator** — clarifies tasks, maintains context, performs small authorized actions through connected services, and prepares specialist handoffs. Heavy coding and deep research stay in your external tools.
- **Useful handoffs** — editable specialist prompts, reviewed read-only artifact snapshots, expiring links, password protection, or explicit public publication.
- **Time-aware tasks** — optional deadlines, calendar views, quiet hours, snooze, persistent notifications, and reminder emails.
- **Fast navigation** — contextual keyboard shortcuts, a command palette, and scoped task/document search.
- **Personal appearance** — Studio, Paper, Pebble, Postcard, Meadow, and Tide styles, independent preset/custom accent colors, and Light/Dark/System modes.
- **Private storage** — encrypted task content at rest and a separately unlocked Vault for sensitive notes and keys.
- **Connections and interoperability** — scoped integration tools behind Symplist contracts and an authenticated incoming MCP interface.

## Project status

**Released and self-hostable.** The monorepo contains the complete application: the Next.js web app, the NestJS API, an optional Trigger.dev worker, fourteen shared packages, 46 expand-only database migrations, deployment configuration, and an automated test suite (unit, integration, browser, accessibility, visual, image, and smoke checks). The latest gate run passed 4,767 unit/integration tests, 61 script tests, 212 browser cases, and both production builds.

The hosted launch is operated as a **free closed beta**: email verification creates an identity; a manually shared invite or administrator unlock grants access. Billing, paywalls, and AI-usage quotas are not part of the project.

## Architecture

| Layer | Selected technology |
| --- | --- |
| Web application | Next.js (React, Tailwind, shadcn on Base UI) |
| Public backend | NestJS; owns authentication, APIs, and WebSockets |
| Structured storage | Cloudflare D1 through direct REST |
| Encrypted object storage | Cloudflare R2 |
| Agent loop | Vercel AI SDK; configurable Fast/Smart provider and model |
| Connections and external tools | Composio, behind Symplist tool contracts |
| Durable execution | Trigger.dev when `DURABLE=true`; Nest-local execution otherwise |
| Transactional email | Resend |
| Product analytics | PostHog (optional, default-off, explicit event allowlist) |

`DURABLE=false` runs agent work and scheduled jobs inside Nest with no Trigger credentials — the simplest self-hosted topology. `DURABLE=true` delegates that work to Trigger.dev; Nest remains the browser delivery boundary. No agent sandboxes are used, and the durable executor keeps only ids, enums, and counts — user content never transits or rests on Trigger in plaintext.

See the [document versioning](docs/notes/files/11_document_versioning.md) and [analytics](docs/notes/files/17_analytics.md) contracts, and the [self-hosting guide](SELF_HOSTING.md) for full deployment topologies.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/web` | Next.js application (workspace, documents, Simon chat, Vault, settings) |
| `apps/api` | NestJS API (auth, sessions, WebSocket, executor boundary) |
| `apps/worker` | Trigger.dev worker (durable mode) |
| `apps/e2e` | Playwright browser, accessibility, and visual suites |
| `packages/` | `contracts` `config` `crypto` `db` `core` `storage` `email` `analytics` `search` `docs` `integrations` `agent` `testing` |
| [`docs/notes/files/`](docs/notes/files/00_index.md) | Numbered product decisions and technical specifications |
| [SELF_HOSTING.md](SELF_HOSTING.md) | Tested local setup, production deployment, operations, backup, and recovery |
| [ROADMAP.md](ROADMAP.md) | What shipped and what is planned |

## Run locally

Symplist requires Node.js 24 (`>=24.15.0 <25`) and pnpm 12.4.2. From a clean checkout:

```sh
corepack enable pnpm
corepack install --global pnpm@12.4.2
pnpm install --frozen-lockfile
```

Create a private `.env.local` from [`.env.example`](.env.example), generate fresh deployment secrets with `pnpm secrets:generate`, fill the empty assignments, and never commit or share the result. Then:

```sh
chmod 600 .env.local
pnpm env:distribute
pnpm env:check
pnpm dev
```

The template defaults to local SQLite/filesystem storage, console-delivered OTPs, and `DURABLE=false`, so no Cloudflare, Resend, or Trigger account is needed to boot. Add an AI provider credential to use Simon.

Read [SELF_HOSTING.md](SELF_HOSTING.md) before accepting real data or deploying to Vercel, Render, Cloudflare, Resend, Trigger.dev, Composio, or PostHog.

## Development

```sh
pnpm dev            # web + api + worker supervisor
pnpm lint           # Biome — zero errors AND zero warnings
pnpm typecheck
pnpm test           # all workspace tests + script tests
pnpm build          # production web build + api build
pnpm e2e            # Playwright across three viewports (slow)
pnpm smoke:local
```

The full contribution checklist — including the release gate every change is held to — is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy and analytics

PostHog is supported for optional product analytics. The implementation uses a small explicit event allowlist, with autocapture, session replay, and automatic page/URL collection disabled. Task text, documents, prompts, chats, secrets, emails, share keys, and private URLs never enter analytics. Standalone artifact viewers and Vault/authentication surfaces do not load the analytics client.

Analytics is optional for self-hosting and disabled by default until explicitly configured. It must not be required for any feature, introduce billing quotas, or be confused with AI-provider usage metering. See the [analytics specification](docs/notes/files/17_analytics.md) and [privacy design](PRIVACY.md). Encryption protects stored content; it is not a blanket end-to-end encryption claim.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [notes index](docs/notes/files/00_index.md). Focused issues and pull requests are welcome. Check existing issues before opening a proposal; large architecture changes should explain their impact on the agreed scope.

Use [GitHub issues](https://github.com/tejassudsfp/symplist/issues) for bugs and proposals. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security concerns privately using [SECURITY.md](SECURITY.md).

## License and maintainer

Symplist is open source under the [MIT License](LICENSE).

Created and maintained by [Tejas Parthasarathi Sudarshan](https://tejassuds.com) · [@tejassudsfp](https://github.com/tejassudsfp).
