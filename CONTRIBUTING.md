# Contributing to Symplist

Thanks for helping make task management simpler. Symplist is a released, self-hostable application — this guide covers getting a change merged.

## Before starting

- Read the [README](README.md) for the product and stack, and the [notes index](docs/notes/files/00_index.md) for the binding product decisions.
- Check [existing issues](https://github.com/tejassudsfp/symplist/issues) and open a focused proposal for anything that alters architecture or scope before writing code.

## Development environment

Node.js 24 (`>=24.15.0 <25`) and pnpm 12.4.2:

```sh
corepack enable pnpm
corepack install --global pnpm@12.4.2
pnpm install --frozen-lockfile
cp .env.example .env.local   # then fill it (see README "Run locally")
pnpm env:distribute && pnpm env:check
pnpm dev
```

## Making a change

1. Fork the repository and create a descriptive branch.
2. Keep the change focused. Preserve user data, existing decisions, and third-party notices.
3. Update related documentation and links. Clearly distinguish proposed, implemented, and verified behavior.
4. Run the checks appropriate to the change. Code contributions must pass and include relevant tests:

   ```sh
   pnpm lint           # Biome — zero errors AND zero warnings
   pnpm typecheck
   pnpm test
   pnpm --filter @symplist/web build
   ```

   Run `pnpm e2e` for anything touching browser behavior, and `python3 scripts/check_docs.py` for documentation changes.
5. Open a pull request explaining the problem, resulting behavior, validation, and any limitations. Include screenshots for visual changes and cover keyboard/mobile states.

Do not commit credentials, `.env*` files (`.env.example` and `apps/*/env.example` templates are the only tracked exceptions), private documents, real invite/share links, or production data. Use fictional fixtures. Do not introduce trackers or new content-disclosure paths without updating the explicit privacy contract. Dependencies and assets must have compatible licenses and retain required attribution.

**Never weaken, skip, or delete a test to reach green.** Fix the code.

## Project conventions

- **Migrations are expand-only** — no `DROP TABLE`, no `RENAME`, no `ALTER ... COLUMN` on an existing table. Add a table or nullable column and dual-read; `packages/db/src/migrations.test.ts` enforces this structurally.
- **Linting is Biome** — ESLint/typescript-eslint do not support the project's TypeScript version.
- **Inside `packages/contracts`, import `z` only from `src/common/zod.ts`** — that module configures `jitless`, which the browser-side CSP (no `unsafe-eval`) requires.
- Commit in logical chunks with plain messages; no attribution or credit trailers.

The project uses the existing MIT license for contributions; no separate contributor agreement is required.

## Main branch policy

All changes to `main` must go through a pull request. Only repository owner `tejassudsfp` can merge. Active GitHub rulesets restrict updates to that user in pull-request context and separately require passing CI, an up-to-date branch, and resolved review conversations, with no bypass of those requirements. Direct pushes, force pushes, and deletion are blocked. An additional approval is not required so the owner can merge their own PRs; CODEOWNERS identifies the maintainer for review requests.

Use a feature branch or fork, wait for checks, and leave merging to the owner. Repository rules are configured on GitHub; this document alone does not enforce them. The owner retains administrative ability to change repository settings.
