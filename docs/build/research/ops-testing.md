# Ops and testing research (verified 2026-09-15)

Scope: Vercel project setup for `apps/web`, Render Blueprint for the NestJS API, GitHub Actions CI and Trigger.dev deploy, lint and format tooling under TypeScript 7, secret generation and env loading, and Playwright E2E with visual and accessibility checks.

How this was verified:

- Versions come from `npm view` (registry) and `gh release list` (GitHub Actions) on 2026-09-15.
- API claims cite official docs. Code marked **(ran)** was executed in a throwaway scratch project with Node 24.15.0 and pnpm 12.4.2. Code marked **(docs)** is taken from the cited docs and was not run here.
- Nothing was deployed to Vercel, Render or GitHub. Everything platform-side is from the docs, and the open questions are listed at the end.

## Versions

| Package / tool | Version | Peer / engine notes |
| --- | --- | --- |
| typescript | 7.0.2 | Only exports `./lib/version.cjs` plus `./unstable/*`. It has no classic compiler API. `bin: tsc` |
| @typescript/typescript6 | 6.0.2 | Official compatibility package. `bin: tsc6`, re-exports the TS 6 API (depends on `typescript@^6`, which resolves to 6.0.3) |
| pnpm | 12.4.2 | engines node `>=18.*` |
| next | 16.3.5 | `next build` runs the project-local `tsc` CLI by default, so TS 7 works |
| @biomejs/biome | 2.5.13 | engines node `>=14.21.3`. Native binary with no install scripts and no `typescript` dependency |
| prettier | 3.9.6 | engines node `>=14`. No dependencies; bundles its own TS 6.0 parser |
| eslint | 10.10.0 | engines node `^20.19.0 \|\| ^22.13.0 \|\| >=24`; optional peer `jiti` |
| @eslint/js | 10.0.1 | peer eslint `^10.0.0` (optional) |
| typescript-eslint | 8.70.0 | peer typescript `>=4.8.4 <6.1.0`, eslint `^8.57.0 \|\| ^9 \|\| ^10`. **Rejects TS 7** |
| eslint-config-next | 16.3.5 | peer eslint `>=9`, typescript `>=3.3.1` (optional); depends on typescript-eslint `^8.46.0` |
| eslint-config-prettier | 10.1.8 | peer eslint `>=7` |
| @playwright/test | 1.63.0 | engines node `>=20`; no `typescript` dependency |
| @axe-core/playwright | 4.13.0 | peer playwright-core `>=1.0.0`; depends on axe-core `~4.13.0` |
| Playwright Docker image | `mcr.microsoft.com/playwright:v1.63.0-noble` | Ubuntu 24.04 image built with `NODE_VERSION=24` |
| @nestjs/config | 12.0.0 | peer @nestjs/common `^11 \|\| ^12`, rxjs `^7.1.0`; ESM-only (`"type": "module"`); bundles dotenv 17.4.2 |
| zod | 4.6.5 | Used for the Standard Schema env validation example |
| trigger.dev (CLI) | 4.6.0 | Must match `@trigger.dev/*` 4.6.0 or CI deploys fail |
| vercel (CLI) | 59.17.0 | engines node `>= 18`. Optional; only needed for `vercel env` |
| actions/checkout | v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`) | runs on node24 |
| actions/setup-node | v7.0.0 (`820762786026740c76f36085b0efc47a31fe5020`) | runs on node24; v7 is an ESM migration and drops the dummy `NODE_AUTH_TOKEN` |
| pnpm/action-setup | v6.1.0 (`ea17c68df8912ef543352723c149a84f56e3d413`) | runs on node24; v6.1.0 release note: "support pnpm v12" |
| actions/upload-artifact | v7.0.1 (`043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`) | runs on node24 |
| pnpm base image | `ghcr.io/pnpm/pnpm:12.4.2` | debian stable-slim with the pnpm binary only; add Node with `pnpm runtime set node 24 -g` |
| Node base image (alternative) | `node:24.21.0-trixie-slim` | Tag exists on Docker Hub |
| Render plan | `0.5c-512mb` | New ID (2026-08-26) for the legacy `starter` plan: 0.5 CPU, 512 MB. The legacy name is still accepted |

## Verified APIs

### 1. TypeScript 7 compatibility evidence

The TS 7 release post says 7.0 ships no API, and that tools like typescript-eslint must run side by side with TS 6 through `@typescript/typescript6`. Source: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

**(ran)** typescript-eslint 8.70.0 with plain `typescript@7.0.2` fails at load:

```text
typescript-eslint does not support TS 7.0.
Please see https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0 ...
See also https://github.com/typescript-eslint/typescript-eslint/issues/10940 for tracking typescript-eslint's support for TS >=7.1
```

**(ran)** With the alias above:

- `tsc -v` prints `Version 7.0.2` and `tsc6 -v` prints `Version 6.0.3`.
- `import('typescript')` resolves to 6.0.3.
- ESLint 10.10.0 + `recommendedTypeChecked` reports `no-floating-promises`, `require-await` and `no-explicit-any` correctly.
- `tsc -p .` (TS 7) passes on the same code.

Tracking: https://github.com/typescript-eslint/typescript-eslint/issues/10940 was open on 2026-09-15. https://github.com/typescript-eslint/typescript-eslint/issues/12518 was closed as "not planned".

Next.js 16.3.5 supports TS 7 in `next build`. Source: https://nextjs.org/docs/app/api-reference/config/typescript

> TypeScript 7 does not currently provide the JavaScript compiler API. [...] Next.js uses the project-local `tsc` CLI by default, so no additional configuration is required.

### 2. Vercel: Next.js app in a pnpm monorepo

Project settings, from https://vercel.com/docs/monorepos, https://vercel.com/docs/builds/configure-a-build and https://vercel.com/docs/monorepos/monorepo-faq:

| Setting | Value |
| --- | --- |
| Framework Preset | Next.js. The build command is the `build` script in `apps/web/package.json`, or `next build` if that script is missing |
| Root Directory | `apps/web` |
| Include source files outside of the Root Directory in the Build Step | On (the default for projects created after 2020-08-27). Required for workspace packages and the root lockfile |
| Skip deployment (skip unaffected projects) | On. Requires GitHub, pnpm workspaces listed in `pnpm-workspace.yaml`, unique package `name`s, and explicit workspace dependencies |
| Node.js Version | 24.x. The page lists 24.x (default), 22.x and 20.x. Only majors can be selected and Vercel rolls out patches itself. Source: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions |
| Install Command | Default (lockfile detection) with Corepack enabled (see below), or an override |

**pnpm 12 on Vercel.** The package-manager docs list pnpm 6 to 10 as supported, and `lockfileVersion: 9.0` maps to "pnpm 9 or 10". Our lockfile is `lockfileVersion: '9.0'`. Source: https://vercel.com/docs/package-managers

The documented way to pin a newer version is Corepack. Source: https://vercel.com/docs/builds/configure-a-build#corepack

- Add the project environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`.
- Keep `"packageManager": "pnpm@12.4.2"` in the root `package.json` (already present).

**(ran)** Local checks:

- Corepack 0.34.6 ran `pnpm 12.4.2` from both the repo root and a workspace subdirectory.
- `pnpm@10.34.5` switched itself to 12.4.2 because of the `packageManager` field.
- `pnpm@9.15.9` did not switch.

An open issue says pnpm 11/12 are not supported without a workaround: https://github.com/vercel/vercel/issues/17434

Optional `apps/web/vercel.json`, only if the Corepack route fails. The keys come from https://vercel.com/docs/project-configuration/vercel-json. **(docs)**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "npx --yes pnpm@12.4.2 install --frozen-lockfile"
}
```

**Ignored Build Step.** Prefer the built-in skip described above, because canceled builds from an Ignored Build Step still count toward deployment quotas. Source: https://vercel.com/docs/project-configuration/project-settings#ignored-build-step

- If a command is used: exit `1` continues the build and exit `0` cancels it.
- The command runs inside the Root Directory.
- `vercel.json` example from https://vercel.com/docs/project-configuration/vercel-json#ignorecommand: **(docs)**

```json
{ "$schema": "https://openapi.vercel.sh/vercel.json", "ignoreCommand": "git diff --quiet HEAD^ HEAD ./" }
```

**Environment variable scoping.** Source: https://vercel.com/docs/environment-variables

- Each variable targets any of Production, Preview, Development or a custom environment.
- Preview variables can be scoped to one Git branch, and branch values override the generic Preview value.
- Changes apply only to new deployments.
- The limit is 64 KB total per deployment.

Since 2026-08-24, variables have a Config or Secret type. Secret values cannot be viewed after saving. The "Separate Production Secret Values" policy forces production secrets to differ from the other environments. Source: https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types

CLI examples from https://vercel.com/docs/cli/env: **(docs)**

```bash
vercel env add NEXT_PUBLIC_API_URL production --no-sensitive < api-url.txt
vercel env add POSTHOG_PERSONAL_KEY production --sensitive < key.txt
vercel env add NEXT_PUBLIC_API_URL preview feature-x < preview-api-url.txt   # branch-scoped Preview
vercel env pull --environment=preview
```

`NEXT_PUBLIC_*` values are inlined into the client bundle at `next build` and frozen after that. Source: https://nextjs.org/docs/app/guides/environment-variables

This means a Preview build only picks up Preview-scoped values, which fits decision A2 (previews have no backend).

**Gating production on CI.** Deployment Checks hold a production deployment until selected GitHub Actions checks pass. The check is identified by job name, so do not rename CI jobs casually. Source: https://vercel.com/docs/deployment-checks

### 3. Render: Blueprint for the Docker API

Field facts come from https://render.com/docs/blueprint-spec and the JSON schema at https://render.com/schema/render.yaml.json:

- `autoDeployTrigger` takes `commit | checksPass | off`. It replaces the deprecated `autoDeploy`; `commit` is the same as `autoDeploy: true`.
- `dockerfilePath` and `dockerContext` are relative to the repo root.
- `rootDir` limits both which changes trigger builds and which files are visible at build and run time. That is why it is left unset below: the API needs the root lockfile and `packages/*`.
- `buildFilter.paths` and `ignoredPaths` are globs relative to the repo root. A synced value fully replaces the existing filters.
- `healthCheckPath` is for web services only and starts with `/`.
- `region` is one of `oregon` (default), `ohio`, `virginia`, `frankfurt`, `singapore`, and cannot change after creation.
- `maxShutdownDelaySeconds` is 1 to 300 (default 30).
- `sync: false` prompts for a value only during initial Blueprint creation. Later syncs ignore it, it is not copied into preview environments, and it is not allowed in env groups.
- `generateValue: true` creates "a base64-encoded 256-bit value".

Draft `render.yaml` at the repo root (schema-checked field names; not synced to Render). **(docs)**

```yaml
services:
  - type: web
    name: symplist-api
    runtime: docker
    branch: main
    region: virginia            # cannot change later; close to Vercel's default iad1
    plan: 0.5c-512mb            # legacy name: starter
    numInstances: 1
    dockerfilePath: ./apps/api/Dockerfile
    dockerContext: .
    autoDeployTrigger: checksPass   # or: commit
    healthCheckPath: /health
    maxShutdownDelaySeconds: 60
    buildFilter:
      paths:
        - apps/api/**
        - packages/**
        - package.json
        - pnpm-lock.yaml
        - pnpm-workspace.yaml
    envVars:
      - key: NODE_ENV
        value: production
      - key: DURABLE
        value: "true"
      - key: TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION
        value: "1"
      - key: CONTENT_KEK
        sync: false
      - key: VAULT_RECOVERY_KEY
        sync: false
      - key: TRIGGER_SECRET_KEY
        sync: false
      - key: CLOUDFLARE_API_TOKEN
        sync: false
      - key: RESEND_API_KEY
        sync: false
```

Other Render facts:

- **`checksPass`** deploys only when all GitHub checks on the commit finish as `success`, `neutral` or `skipped`. It never deploys if the commit has zero checks. Source: https://render.com/docs/deploys#integrating-with-ci
- **PORT:** "The default value of `PORT` is `10000` for all Render web services." Every web service "must bind to a port on host `0.0.0.0`". Ports 18012, 18013 and 19099 are reserved. Source: https://render.com/docs/web-services
- **Health checks:** an HTTP check passes on any 2xx or 3xx within 5 seconds. A new deploy gets traffic only once all new instances pass, and is canceled after 15 minutes. A running instance is pulled from traffic after 15 seconds of failures and restarted after 60 seconds. Source: https://render.com/docs/health-checks
- **WebSockets:** Render has no maximum connection duration. Clients should use `wss://` (plain `ws://` gets a 301), send ping/pong keepalives (the docs use 30 s), and reconnect with exponential backoff. On deploy an instance gets `SIGTERM` and 30 s by default (up to 300 s). The load balancer may send a reconnect to a different instance. Source: https://render.com/docs/websocket
- **Docker env vars:** Render turns env vars into Docker build args, so Dockerfiles must not reference secret build args. Use secret files instead. Sources: https://render.com/docs/docker and https://render.com/docs/docker-secrets
- **Commit SHA:** `RENDER_GIT_COMMIT` is available at runtime, so Trigger.dev skew protection can read it once `TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION=1` is set. Sources: https://render.com/docs/environment-variables and https://trigger.dev/docs/deployment/version-skew-protection

Nest bootstrap that honours PORT and SIGTERM. The `listen(port, hostname)` and `enableShutdownHooks()` signatures were checked in `@nestjs/common@12.0.3` typings. Lifecycle docs: https://docs.nestjs.com/fundamentals/lifecycle-events **(docs)**

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();                       // run OnApplicationShutdown on SIGTERM
await app.listen(Number(process.env.PORT ?? 10000), "0.0.0.0");
```

Dockerfile skeleton adapted from pnpm's monorepo recipe (https://pnpm.io/docker). It was not built here. `pnpm deploy` in that recipe expects `injectWorkspacePackages: true` in `pnpm-workspace.yaml`. **(docs)**

```dockerfile
FROM ghcr.io/pnpm/pnpm:12.4.2 AS base
RUN pnpm runtime set node 24 -g

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @symplist/api... run build
RUN pnpm deploy --filter=@symplist/api --prod /prod/api

FROM base
COPY --from=build /prod/api /prod/api
WORKDIR /prod/api
EXPOSE 10000
CMD ["node", "dist/main.js"]
```

### 4. GitHub Actions

pnpm and Node setup. Sources: https://github.com/pnpm/action-setup (README, v6.1.0) and https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md

- Omit `version` when `packageManager` or `devEngines.packageManager` is set.
- `pnpm/action-setup` does not install Node.
- For `cache: 'pnpm'`, `setup-node` needs pnpm installed first.
- `node-version-file` accepts `.nvmrc`.
- `check-latest` applies to LTS-style specs.
- Playwright recommends `npx playwright install --with-deps` on runners, or the official container for stable screenshots. Browser caching is not recommended. Sources: https://playwright.dev/docs/ci-intro and https://playwright.dev/docs/ci

Trigger.dev deploy facts. Sources: https://trigger.dev/docs/github-actions and https://trigger.dev/docs/cli-deploy-commands

- The job needs the `TRIGGER_ACCESS_TOKEN` secret.
- The CLI version must match the SDK version.
- `--external-id ${{ github.sha }}` makes deploys idempotent per commit. Do not add a `paths:` filter, or skew pinning expires runs.
- `--env` defaults to `prod`.

**(ran)** Two pnpm gotchas:

- `pnpm --filter @x/worker deploy` runs pnpm's built-in `deploy` and fails with `ERR_PNPM_INVALID_DEPLOY_TARGET`. Use `run deploy`.
- `pnpm run deploy -- --flag` forwards the `--` literally, so pass flags without `--`.

`.github/workflows/ci.yml`. The `concurrency` syntax follows https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax-for-github-actions. **(docs)**

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0 (reads packageManager)
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .nvmrc
          check-latest: true
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome ci --reporter=github .
      - run: pnpm -r typecheck
      - run: pnpm -r test
      - run: pnpm -r build

  e2e:
    needs: verify
    runs-on: ubuntu-latest
    timeout-minutes: 30
    container:
      image: mcr.microsoft.com/playwright:v1.63.0-noble   # must equal @playwright/test version
      options: --user 1001
    env:
      CI: "true"
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @symplist/e2e... run build
      - run: pnpm --filter @symplist/e2e exec playwright test
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: apps/e2e/playwright-report/
          retention-days: 14

  deploy-trigger:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: [verify, e2e]
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: trigger-deploy-prod
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --filter @symplist/worker...
      - name: Deploy Trigger.dev tasks
        env:
          TRIGGER_ACCESS_TOKEN: ${{ secrets.TRIGGER_ACCESS_TOKEN }}
        run: pnpm --filter @symplist/worker run deploy --external-id "$GITHUB_SHA"
```

If Playwright runs on the plain runner instead of the container, replace the `container:` block with a step `pnpm --filter @symplist/e2e exec playwright install --with-deps chromium`. Source: https://playwright.dev/docs/ci-intro

### 5. Lint and format

**Biome 2.5.13 (recommended)**

Config facts:

- `linter.rules.preset` is `recommended | all | none`; the older `recommended` key is deprecated.
- `javascript.parser.unsafeParameterDecoratorsEnabled` enables Nest's `@Body()`-style parameter decorators.
- `vcs.useIgnoreFile` reads `.gitignore`.
- `formatter.indentStyle` defaults to `tab`.

Source: https://biomejs.dev/reference/configuration/

- The `next` and `react` domains add framework rules. Source: https://biomejs.dev/linter/domains/
- `noFloatingPromises` is a nursery rule in the Types domain and turns on Biome's own type inference, with no `typescript` package involved. Source: https://biomejs.dev/linter/rules/no-floating-promises/
- CI uses `biome ci`. Source: https://biomejs.dev/recipes/continuous-integration/

**(ran)** Results with Biome 2.5.13:

- The config below flags `<img>` in `apps/web` (`noImgElement` via the `next` domain).
- It flags an un-awaited promise inside a decorated Nest controller.
- Without the parser option, Nest parameter decorators are a parse error.
- `biome ci --reporter=github` emits `::error` annotations and exits 1.

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.13/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["apps/**", "packages/**", "!**/.next", "!**/dist"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": { "preset": "recommended", "nursery": { "noFloatingPromises": "error" } }
  },
  "javascript": { "formatter": { "quoteStyle": "double" } },
  "assist": { "enabled": true, "actions": { "source": { "organizeImports": "on" } } },
  "overrides": [
    { "includes": ["apps/web/**"], "linter": { "domains": { "next": "recommended", "react": "recommended" } } },
    { "includes": ["apps/api/**"], "javascript": { "parser": { "unsafeParameterDecoratorsEnabled": true } } }
  ]
}
```

**Fallback: ESLint 10 + typescript-eslint 8.70.0 + Prettier 3.9.6 (ran)**

This only works with `typescript` aliased to `@typescript/typescript6@6.0.2` and TS 7 installed as `@typescript/native`. The flat config comes from https://typescript-eslint.io/getting-started/typed-linting.

```js
// eslint.config.mjs
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
);
```

Next.js-specific ESLint setup:

- `next lint` was removed in Next 16; run the ESLint CLI instead.
- The Next flat config is `defineConfig([...nextVitals, ...nextTs, globalIgnores([...])])` from `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`.
- `nextTs` uses typescript-eslint, so it has the same TS 7 limitation.

Source: https://nextjs.org/docs/app/api-reference/config/eslint

**(ran)** Prettier 3.9.6 formats TS correctly with TS 7 installed, because it bundles its own parser.

### 6. Secrets and env loading

Node APIs (sources: https://nodejs.org/docs/latest-v24.x/api/crypto.html and https://nodejs.org/docs/latest-v24.x/api/buffer.html):

- `crypto.randomBytes(size)` returns a Buffer of cryptographically strong bytes.
- `'base64url'` is RFC 4648 §5. Encoding omits padding, and decoding also accepts regular base64.
- `crypto.randomInt(min, max)` avoids modulo bias.
- `crypto.timingSafeEqual(a, b)` compares in constant time.

**(ran)** Encoded lengths:

| Bytes | base64url chars |
| --- | --- |
| 16 | 22 |
| 24 | 32 |
| 32 | 43 |
| 48 | 64 |
| 64 | 86 |

Decoding is lenient: `Buffer.from("not a key!!", "base64url")` returns 5 bytes, so validate by length and round-trip.

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

```ts
export function decodeKey32(value: string): Buffer {
  const buf = Buffer.from(value, "base64url");
  const canonical = value.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
  if (buf.length !== 32 || buf.toString("base64url") !== canonical) {
    throw new Error("expected 32 random bytes encoded as base64url (43 chars)");
  }
  return buf;
}
```

**Node 24 `--env-file`.** Source: https://nodejs.org/docs/latest-v24.x/api/cli.html#--env-filefile

- `--env-file`, `--env-file-if-exists` and `process.loadEnvFile()` are no longer experimental as of v24.10.0.
- Real environment variables override values from the file.
- `--env-file` throws if the file is missing; `--env-file-if-exists` does not.

**(ran)** On 24.15.0:

- Quotes, comments and `export` prefixes parse as documented.
- `A=env node --env-file=...` keeps `env`.
- `--env-file=missing.env` exits with `node: missing.env: not found`.

**@nestjs/config 12.0.0.** Source: https://docs.nestjs.com/techniques/configuration

- `ConfigModule.forRoot()` loads `.env` through dotenv, and runtime env wins.
- Options include `envFilePath`, `ignoreEnvFile`, `isGlobal`, `cache`, `validationSchema` (any Standard Schema such as Zod), `validate`, `validatePredefined` and `skipProcessEnv`. All were confirmed in `dist/interfaces/config-module-options.interface.d.ts`.

**(ran)** JS equivalent of the snippet below on Nest 12.0.3 with zod 4.6.5:

- Values from `--env-file-if-exists=.env` were read, and `PORT` was coerced to a number.
- A platform `PORT=10000` overrode the file.
- An invalid key failed boot with `Config validation error: CONTENT_KEK: ...`.
- With `logger: false` that failure exited 1 silently.

```ts
import { z } from "zod";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true, // Node loads .env locally; Render injects real env in production
      cache: true,
      validationSchema: z.object({
        NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
        PORT: z.coerce.number().int().default(10000),
        CONTENT_KEK: z.string().refine((v) => {
          try { decodeKey32(v); return true; } catch { return false; }
        }, "must be 32 random bytes encoded as base64url (43 chars)"),
      }),
    }),
  ],
})
export class AppModule {}
```

### 7. Playwright: Next and Nest together, three viewports, axe

`webServer` facts. Source: https://playwright.dev/docs/test-webserver

- It accepts an array of servers.
- `url` is ready on 2xx, 3xx, 400, 401, 402 or 403.
- Other options: `name`, `cwd` (defaults to the config directory), `env` (inherits `process.env` plus `PLAYWRIGHT_TEST=1`), `timeout` (default 60000), `reuseExistingServer`, `gracefulShutdown: { signal: 'SIGTERM', timeout }` (the default is SIGKILL), and `wait: { stdout: /regex/ }`.

Screenshot facts. Sources: https://playwright.dev/docs/test-snapshots and https://playwright.dev/docs/api/class-testconfig

- Rendering differs by OS and browser, so compare in the same environment that produced the baselines.
- `expect.toHaveScreenshot` options: `animations` (default `"disabled"`), `caret`, `maxDiffPixels`, `maxDiffPixelRatio`, `threshold`, `stylePath`, `pathTemplate`.
- `snapshotPathTemplate` tokens include `{platform}` and `{projectName}`.

Viewport per project: set `viewport` after spreading `devices[...]`. Source: https://playwright.dev/docs/emulation#viewport

axe facts. Sources: https://playwright.dev/docs/accessibility-testing and https://github.com/dequelabs/axe-core/blob/develop/doc/API.md

- Scan with `new AxeBuilder({ page }).withTags([...]).analyze()`.
- Use `include()` / `exclude()` / `disableRules()` for known issues.
- axe-core 4.13 tags include `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice`.

**(ran)** Playwright 1.63.0 + @axe-core/playwright 4.13.0 + TS 7.0.2:

- Two stand-in servers started as a `webServer` array.
- Three projects produced 1440x900, 1024x768 and 390x844 PNGs (checked). The first CI run wrote baselines and failed as expected; the second run passed 3 of 3.
- The axe scan with WCAG 2.2 AA tags passed.
- `tsc -p .` (TS 7) type-checked the config and spec.

**Import gotcha (ran):** `import AxeBuilder from "@axe-core/playwright"` fails TS 7 `nodenext` typechecking in an ESM package (`TS2351: This expression is not constructable`). The exports map points `types` at the CJS `.d.ts`. Use the named export `import { AxeBuilder } from "@axe-core/playwright"`.

```ts
// apps/e2e/playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

const WEB_URL = "http://127.0.0.1:3000";
const API_URL = "http://127.0.0.1:4000";

export default defineConfig({
  testDir: "./tests",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{projectName}/{testFilePath}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  use: { baseURL: WEB_URL, trace: "on-first-retry" },
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "tablet-1024", use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } } },
    {
      name: "mobile-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    },
  ],
  webServer: [
    {
      name: "api",
      command: "pnpm --filter @symplist/api run start:prod",
      url: `${API_URL}/health`,
      env: { PORT: "4000", NODE_ENV: "test" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      name: "web",
      command: "pnpm --filter @symplist/web exec next start -p 3000",
      url: WEB_URL,
      env: { NEXT_PUBLIC_API_URL: API_URL },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
```

```ts
// apps/e2e/tests/home.spec.ts
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("home: visual + WCAG 2.2 AA", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page).toHaveScreenshot("home.png", { fullPage: true });

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  await testInfo.attach("axe-results", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  expect(results.violations).toEqual([]);
});
```

## Decisions and recommendations

1. **Lint and format: Biome 2.5.13 for the whole monorepo.** It runs with `typescript@7.0.2` everywhere and needs no second TypeScript. It covers the Next domain rules, handles Nest parameter decorators via an override, and gives partial type-aware checks through nursery `noFloatingPromises`. Type correctness still comes from `tsc` 7 in `pnpm -r typecheck`.
   - Keep ESLint + typescript-eslint + Prettier as the documented fallback. It requires aliasing `typescript` to `@typescript/typescript6@6.0.2` in the linting package only. Revisit when typescript-eslint ships TS 7.1 API support (issue 10940).
2. **Vercel project `symplist-web`:**
   - Root Directory `apps/web`, Framework Next.js, Node 24.x.
   - Keep "Include source files outside the Root Directory" and "Skip deployment" on. Declare every workspace dependency explicitly in `package.json` so skipping works.
   - Set `ENABLE_EXPERIMENTAL_COREPACK=1` for all environments so pnpm 12.4.2 is used, and confirm in the first build log. If Corepack fails, fall back to `installCommand` in `apps/web/vercel.json`.
   - No `vercel.json` otherwise. No Ignored Build Step.
   - Scope API URLs and PostHog keys per environment. Use the Secret type for secrets. Enable Deployment Checks on the CI `verify` and `e2e` jobs.
3. **Render service `symplist-api`:**
   - `runtime: docker`, `dockerfilePath: ./apps/api/Dockerfile`, `dockerContext: .`, no `rootDir` (it would hide the lockfile and `packages/*`).
   - `buildFilter` on the API, `packages` and the root manifests.
   - `plan: 0.5c-512mb` (same as `starter`), `branch: main`, `healthCheckPath: /health`.
   - `autoDeployTrigger: checksPass`, so the API deploys only after CI and the Trigger.dev deploy succeed.
   - All secrets use `sync: false`. Add later secrets in the dashboard, because Blueprint syncs ignore them.
4. **Nest on Render:**
   - `app.listen(Number(process.env.PORT ?? 10000), "0.0.0.0")` and `enableShutdownHooks()`.
   - Give `/health` a cheap dependency check.
   - Set `maxShutdownDelaySeconds` to about 60 so WebSocket and chat streams can close cleanly.
   - Clients reconnect with backoff and send pings about every 30 s.
5. **CI (`.github/workflows/ci.yml`):**
   - One workflow with `verify` (install, `biome ci`, typecheck, test, build), then `e2e` (Playwright container pinned to the same version), then `deploy-trigger` (main only, `environment: production`, `--external-id $GITHUB_SHA`).
   - Pin actions by commit SHA with version comments, in line with the repo's supply-chain posture.
   - Upgrade the existing `docs.yml` from `actions/checkout@v4` to v7.0.1.
6. **Trigger.dev deploy:**
   - Call `pnpm --filter @symplist/worker run deploy --external-id "$GITHUB_SHA"`, never `pnpm --filter ... deploy`.
   - No `paths:` filter.
   - Set `TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION=1` on Render, where `RENDER_GIT_COMMIT` exists at runtime, so API-triggered runs pin to the matching task deployment.
7. **Secrets:**
   - Generate with `randomBytes(32).toString("base64url")` (43 chars) for `CONTENT_KEK`, `VAULT_RECOVERY_KEY`, session and HMAC secrets, and the random part of API keys.
   - Validate at boot with a length plus round-trip check.
   - Compare hashes with `timingSafeEqual`. Use `randomInt` for OTP digits.
   - Do not use Render `generateValue` for KEKs: the value would exist only inside Render, so it should be generated and escrowed by the owner first.
8. **Env loading:**
   - Local runs use `node --env-file-if-exists=.env`.
   - Nest uses `ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, cache: true, validationSchema: z.object(...) })`, so there is one loader and one schema.
   - Production relies on platform env only. Keep `.env*` in `.dockerignore`.
   - Never pass `logger: false` to Nest bootstrap, because it hides config validation errors.
9. **E2E:**
   - A dedicated `@symplist/e2e` workspace package that depends on `@symplist/web` and `@symplist/api`, as Vercel's skip logic expects.
   - A `webServer` array running production builds (Nest `start:prod`, `next start`) with the API on the local development adapters (decision A7).
   - Three viewport projects, 1440, 1024 and 390.
   - `snapshotPathTemplate` includes `{platform}`, and only Linux baselines generated in the Playwright container are committed.
   - axe runs with WCAG 2.0/2.1/2.2 A and AA tags, and the results are attached to the report.

## Risks and open questions

**Toolchain and TypeScript 7**

- typescript-eslint, and therefore `eslint-config-next/typescript`, does not work with TS 7.0.x. The published peer is `<6.1.0` and it throws at load. The TS 7 API is expected in 7.1, with no date verified here.
- Biome's `noFloatingPromises` is a nursery rule and its type inference is weaker than typescript-eslint's. Confirm that the React hooks rules cover what `eslint-plugin-react-hooks` would catch.

**Vercel**

- Vercel does not officially list pnpm 11 or 12 (https://github.com/vercel/vercel/issues/17434 is open). The Corepack route was verified locally only, and one community report saw Corepack pick the wrong pnpm major. Check the first build log.
- Deployment Checks plan availability and Hobby-plan behavior were not confirmed. The docs page does not state a plan tier.

**Render**

- `checksPass` blocks the Render deploy if any detected GitHub check fails, such as a flaky E2E run. Render detects GitHub Actions and GitHub Checks API integrations; whether it also counts Vercel's check was not verified. It also never deploys a commit with zero checks. Switch to `commit` if that coupling proves too strict.
- Render's docs do not mention BuildKit cache mounts (`RUN --mount=type=cache`), so the Dockerfile avoids them. The skeleton above has not been built.
- A single instance means every deploy sends `SIGTERM` and drops open WebSockets. Reconnect handling is required, not optional.
- `sync: false` values are prompted only at Blueprint creation. New secrets must be added manually and are not copied to Render preview environments.

**CI and Playwright**

- The Playwright container job (`--user 1001`) combined with `pnpm/action-setup` and `setup-node` caching was not run on GitHub. If home-directory permissions break, run on the runner with `playwright install --with-deps chromium`.
- Screenshot baselines are OS-specific. Developers on macOS must regenerate Linux baselines in the container. The exact `docker run` wrapper for pnpm inside the container still needs to be written and tested.

**Nest and Trigger.dev**

- `@nestjs/config` 12 is ESM-only. The Nest build pipeline (Nest CLI, SWC or tsc 7) and decorator metadata under TS 7 are outside this topic and must be verified by the backend research.
- Trigger.dev skew protection: if a commit's task deploy never lands, API-triggered runs wait up to 1 hour and then expire. `deploy-trigger` must run for every commit on main (no `paths:` filter). Redeploying the same SHA after changing synced env vars needs an empty commit or `--force`.
