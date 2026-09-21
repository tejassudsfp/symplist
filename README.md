# Symplist

**The most productive thing is often the most simple.**

A calm task workspace for keeping track of what matters, making progress, and handing bigger work to the right tools.

[Self-hosting guide](SELF_HOSTING.md) · [Product specification](docs/notes/files/01_product.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)

## Project status

**Runnable closed-beta application.** The monorepo contains the Next.js web app, NestJS API, optional Trigger.dev worker, shared packages, 46 expand-only migrations, deployment configuration, and automated unit, integration, browser, accessibility, visual, image, and smoke checks. The product is implemented across the 44 screen briefs and six visual themes.

The planned hosted launch is a **free closed beta**. Email verification creates an identity; a manually shared invite or administrator unlock grants access. Invites are not automatically sent to people who sign up. Payments, paywalls, and subscription quotas are outside the beta scope.

## The idea

Open Symplist and start with **Now**, **Later**, or **Unclassified**. Select a task to see its Markdown page and its conversation with Simon. Keep the surface simple; open deeper features when needed.

Simon is a productivity facilitator. It helps clarify tasks, maintain useful context, perform small authorized actions through connected services, and prepare specialist handoffs. Heavy coding and deep research happen in the user's chosen external tools.

### Capabilities

- **A focused workspace:** task inboxes, subtasks, drag-and-drop movement, archive/restore, and responsive page/chat panels.
- **Documents with real history:** Markdown backed by actual Git, with encrypted artifacts in R2 and indexed publication in D1.
- **Useful handoffs:** editable specialist prompts and reviewed read-only artifact snapshots, with expiring links, password protection, or explicit public publication.
- **Time-aware tasks:** optional deadlines, calendar views, quiet hours, snooze, persistent notifications, and reminder emails.
- **Fast navigation:** contextual keyboard shortcuts, a command palette, and scoped task/document search.
- **Personal appearance:** Studio, Paper, Pebble, Postcard, Meadow, and Tide styles, independent preset/custom accent colors, and Light/Dark/System modes.
- **Private storage:** encrypted task content and a separately unlocked Vault for sensitive notes and keys.
- **Connections and interoperability:** scoped integration tools and an authenticated incoming MCP interface.

## Architecture

| Layer | Selected technology |
| --- | --- |
| Web application | Next.js |
| Public backend | NestJS; owns authentication, APIs, and WebSockets |
| Structured storage | Cloudflare D1 through direct REST |
| Encrypted object storage | Cloudflare R2 |
| Agent loop | Vercel AI SDK; configurable Fast/Smart provider and model |
| Connections and external tools | Composio, behind Symplist tool contracts |
| Durable execution | Trigger.dev when enabled; Nest-local execution otherwise |
| Transactional email | Resend |
| Product analytics | PostHog; explicit events with private content excluded |
| Frontend hosting | Vercel |
| Initial backend hosting | Render, with later AWS portability |

`DURABLE=false` runs agent work and scheduled jobs inside Nest without Trigger credentials. `DURABLE=true` delegates that work to Trigger; Nest remains the browser delivery boundary. No agent sandboxes are planned.

See the [document versioning](docs/notes/files/11_document_versioning.md) and [analytics](docs/notes/files/17_analytics.md) contracts.

## Explore the repository

| Path | Contents |
| --- | --- |
| [`docs/notes/files/`](docs/notes/files/00_index.md) | Numbered product decisions and technical specifications |
| [Self-hosting guide](SELF_HOSTING.md) | Tested local setup, production deployment, operations, backup, and recovery |
| [Roadmap](ROADMAP.md) | Implementation sequence and release gates |


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

The template defaults to local SQLite/filesystem storage, console-delivered OTPs, and `DURABLE=false`, so no Cloudflare, Resend, or Trigger account is needed to boot. Add the selected AI provider credential to use Simon. Read [SELF_HOSTING.md](SELF_HOSTING.md) before accepting real data or deploying to Vercel, Render, Cloudflare, Resend, Trigger.dev, Composio, or PostHog.

## Privacy and analytics

PostHog is supported for optional product analytics. The implementation uses a small explicit event allowlist, with autocapture, session replay, and automatic page/URL collection disabled. Task text, documents, prompts, chats, secrets, emails, share keys, and private URLs never enter analytics. Standalone artifact viewers and Vault/authentication surfaces do not load the analytics client.

Analytics is optional for self-hosting and disabled by default until explicitly configured. It must not be required for any feature, introduce billing quotas, or be confused with AI-provider usage metering. Read the [analytics specification](docs/notes/files/17_analytics.md) and [privacy design](PRIVACY.md). Encryption protects stored content; it is not a blanket end-to-end encryption claim.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [notes index](docs/notes/files/00_index.md). Focused issues and pull requests are welcome for specifications, UX, accessibility, and implementation. Check existing issues before opening a proposal. Large architecture changes should explain their impact on the agreed scope.

Use [GitHub issues](https://github.com/tejassudsfp/symplist/issues) for ordinary bugs and proposals. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security concerns privately using [SECURITY.md](SECURITY.md).

## License and maintainer

Symplist is open source under the [MIT License](LICENSE).

Created and maintained by [Tejas Parthasarathi Sudarshan](https://tejassuds.com) · [@tejassudsfp](https://github.com/tejassudsfp).
