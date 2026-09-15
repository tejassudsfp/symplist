# Symplist

**The most productive thing is often the most simple.**

A calm task workspace for keeping track of what matters, making progress, and handing bigger work to the right tools.

[Product specification](docs/notes/files/01_product.md) · [Design reference](<design/UI sample/README.md>) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)

## Project status

**Pre-implementation.** This repository contains the product and architecture specifications, 44 screen design briefs, an interactive workspace design reference, and an end-to-end build handoff. It does not yet contain a runnable application, hosted service, or installable release.

The planned hosted launch is a **free closed beta**. Email verification creates an identity; a manually shared invite or administrator unlock grants access. Invites are not automatically sent to people who sign up. Payments, paywalls, and subscription quotas are outside the beta scope.

## The idea

Open Symplist and start with **Now**, **Later**, or **Unclassified**. Select a task to see its Markdown page and its conversation with Simon. Keep the surface simple; open deeper features when needed.

Simon is a productivity facilitator. It helps clarify tasks, maintain useful context, perform small authorized actions through connected services, and prepare specialist handoffs. Heavy coding and deep research happen in the user's chosen external tools.

### Planned capabilities

- **A focused workspace:** task inboxes, subtasks, drag-and-drop movement, archive/restore, and responsive page/chat panels.
- **Documents with real history:** Markdown backed by actual Git, with encrypted artifacts in R2 and indexed publication in D1.
- **Useful handoffs:** editable specialist prompts and reviewed read-only artifact snapshots, with expiring links, password protection, or explicit public publication.
- **Time-aware tasks:** optional deadlines, calendar views, quiet hours, snooze, persistent notifications, and reminder emails.
- **Fast navigation:** contextual keyboard shortcuts, a command palette, and scoped task/document search.
- **Personal appearance:** Studio, Paper, Pebble, and Postcard styles, independent preset/custom accent colors, and Light/Dark/System modes.
- **Private storage:** encrypted task content and a separately unlocked Vault for sensitive notes and keys.
- **Connections and interoperability:** scoped integration tools and an authenticated incoming MCP interface.

These are specified capabilities, not a claim that they are implemented.

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
| Initial backend hosting | Render, with later AWS portability |

`DURABLE=false` runs agent work and scheduled jobs inside Nest without Trigger credentials. `DURABLE=true` delegates that work to Trigger; Nest remains the browser delivery boundary. No agent sandboxes are planned.

See [architecture](docs/notes/files/07_architecture.md), [document versioning](docs/notes/files/11_document_versioning.md), and [analytics](docs/notes/files/17_analytics.md) for the full contracts.

## Explore the repository

| Path | Contents |
| --- | --- |
| [`docs/notes/files/`](docs/notes/files/00_index.md) | Numbered product decisions and technical specifications |
| [`design/UI sample/`](<design/UI sample/README.md>) | Supplied workspace reference and its companion runtime |
| [`design/mockups/`](design/mockups/overall.md) | Master design brief, theme system, and 44 individual screen briefs |
| [`docs/prompts/`](<docs/prompts/build prompt.md>) | Complete build handoff, required flows, and verification criteria |
| [Self-hosting preparation](docs/notes/files/08_self_hosting.md) | Infrastructure requirements for the eventual application |
| [Roadmap](ROADMAP.md) | Implementation sequence and release gates |

To inspect the design export locally, serve the sample directory with a static HTTP server, for example:

```sh
python3 -m http.server 8000 --directory "design/UI sample" --bind 127.0.0.1
```

Then open `http://127.0.0.1:8000/workspace_now.dc.html`. This serves a design reference, not the application. The export references online fonts; its state/theme/viewport controls are design-review tooling.

## Self-hosting prompt

Self-hosting is a project requirement; a runnable release is not available yet. Give the following prompt to your preferred development assistant with this repository open:

```text
Help me self-host Symplist from this checkout. First read README.md,
docs/notes/files/00_index.md, 07_architecture.md, 08_self_hosting.md,
and the relevant security, access, analytics, and execution specifications.
Inspect the actual source and release status before proposing commands.

If the application is not implemented yet, state that clearly. Use
“docs/prompts/build prompt.md” for the implementation scope; do not pretend
the UI reference is a deployable app or invent installation commands.

For a runnable version, prepare and verify a reproducible deployment using
Next.js, NestJS, D1 via direct REST, encrypted R2 storage, and Resend.
Default DURABLE=false so no Trigger credentials are required; explain the
optional Trigger setup. Keep billing/paywall/AI quotas disabled and PostHog
analytics off unless I explicitly enable it. Configure AI providers/models
and Composio only with my own credentials and authorized connections.

Explain BETA_ACCESS_REQUIRED and let me choose private invite admission or
access for all verified accounts. Preserve authentication and ownership in
either mode. Set up the operator account explicitly, never by first signup.

Provide a complete environment checklist without printing secrets, database
migrations, Git runtime setup, encryption/recovery-key generation and backup,
HTTPS/origin/callback configuration, startup commands, and health checks.
Include persistent reminder recovery, artifact-link protections, backups,
restore, upgrades, and troubleshooting. Use Render initially unless I choose
another host, and keep the setup portable. No central hosted license or
analytics service may be mandatory.

Run available build/tests and a clean-install smoke test. Distinguish local
verification from live integration checks requiring credentials. Prepare
reviewable deployment files first; ask before creating paid resources,
publishing a live service, or sending external test messages. Finish with
exact commands, required configuration, and any genuinely blocked steps.
```

See [self-hosting preparation](docs/notes/files/08_self_hosting.md) for the full requirements. Never paste live secrets into an issue or a prompt.

## Privacy and analytics

PostHog is selected for product analytics. The implementation must use a small explicit event allowlist, with autocapture, session replay, and automatic page/URL collection disabled. Task text, documents, prompts, chats, secrets, emails, share keys, and private URLs must never enter analytics. Standalone artifact viewers and Vault/authentication surfaces do not load the analytics client.

Analytics is optional for self-hosting and disabled by default until explicitly configured. It must not be required for any feature, introduce billing quotas, or be confused with AI-provider usage metering. Read the [analytics specification](docs/notes/files/17_analytics.md) and [privacy design](PRIVACY.md). Encryption protects stored content; it is not a blanket end-to-end encryption claim.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [notes index](docs/notes/files/00_index.md). Focused issues and pull requests are welcome for specifications, UX, accessibility, and implementation. Check existing issues before opening a proposal. Large architecture changes should explain their impact on the agreed scope.

Use [GitHub issues](https://github.com/tejassudsfp/symplist/issues) for ordinary bugs and proposals. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security concerns privately using [SECURITY.md](SECURITY.md).

## License and maintainer

Symplist is open source under the [MIT License](LICENSE).

Created and maintained by [Tejas Parthasarathi Sudarshan](https://tejassuds.com) · [@tejassudsfp](https://github.com/tejassudsfp).
