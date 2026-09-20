# Backend research (verified 2026-09-15)

Scope: the NestJS API on Render. It covers the Nest 12 packages, TypeScript 7 compatibility, builds and dev loop, Vitest, Zod request validation, the raw `ws` WebSocket gateway (auth on upgrade and heartbeats), helmet and cookies, rate limiting, graceful shutdown, and the Render runtime (native vs Docker, Dockerfile and `render.yaml`).

Method:
- Versions come from `npm view <pkg> version` and `npm view <pkg> peerDependencies engines --json`, plus `dist-tags` and `time`.
- API facts come from the official docs. Nest docs were read from their Markdown source, which is what `https://docs.nestjs.com/<page>` renders. Render docs were read from the live pages. Where the docs are silent, the installed package source was read and is named as such.
- All experiments ran in a throwaway pnpm 12.4.2 workspace on Node 24.15.0, using the repo's pnpm 12 policies (`allowBuilds`, default `minimumReleaseAge`). Nothing was installed into the Symplist repository. These experiments ran and passed:
  - An ESM Nest 12.0.3 app compiled with **TypeScript 7.0.2 `tsc`** (`experimentalDecorators` + `emitDecoratorMetadata`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and run with `node dist/main.js`. The following all worked: constructor DI; Zod 4.6.5 validation through `StandardSchemaValidationPipe` (400 on bad input, coercion of `:id` to number); `@nestjs/config` Zod env validation; helmet headers; `cookie-parser`; CORS with credentials; `rawBody`; `@nestjs/throttler` 429s; `ScheduleModule` boot.
  - The `WsAdapter` gateway on the HTTP port at `/ws`:
    - Upgrade auth via `verifyClient` returned 401 with no session and 403 for a bad `Origin`.
    - Authenticated sockets got replies.
    - Server pings arrived at the client.
    - On SIGTERM, clients were closed with code 1001.
  - `nest build` (tsc builder, SWC builder, and `--type-check`) **fails** with TypeScript 7.0.2 installed. The same builds pass with `typescript` aliased to `@typescript/typescript6@6.0.2`.
  - Vitest 5.0.1 unit and e2e tests (`@nestjs/testing`, real HTTP and a real WebSocket) passed both with `unplugin-swc` 1.6.0 and with **no plugin** (Vite 8's Oxc transform).
  - The exact `main.ts`, `ws-auth.adapter.ts` and `events.gateway.ts` snippets below were copied from this file back into the probe. They compiled with TS 7.0.2 and passed the Vitest e2e tests, and a live client got a reply and then a 1001 close on SIGTERM.
  - A Docker image `node:24.21.0-trixie-slim` + apt `git` + `tini` built with `pnpm deploy`:
    - It served `/healthz` and ran `git bundle create/verify`.
    - It stopped cleanly on SIGTERM, both with `tini` and with node as PID 1.
    - Local builds used the classic builder; the BuildKit cache mount in the final Dockerfile was not exercised locally.

## Versions

| package | version | peer/engine notes |
| --- | --- | --- |
| `@nestjs/core` | 12.0.3 (`latest`, published 2026-09-15; `legacy` tag = 11.2.5) | engines `node >= 20`. Peers `@nestjs/common ^12`, `reflect-metadata ^0.1.12 \|\| ^0.2.0`, `rxjs ^7.1.0` (optional peers: websockets, microservices, platform-express). Package is `"type": "module"` (ESM-only). |
| `@nestjs/common` | 12.0.3 | Peers `reflect-metadata`, `rxjs`; `class-validator`/`class-transformer` optional (not needed with Standard Schema). Exports only `.`, `./internal`, `./*`. The deep path `@nestjs/common/interfaces` no longer resolves. |
| `@nestjs/platform-express` | 12.0.3 | Depends on `express 5.2.1`, `cors 2.8.6`, `multer 2.4.0`. **Chosen.** |
| `@nestjs/platform-fastify` | 12.0.3 | Depends on `fastify 5.12.4`. Not chosen (see decisions). |
| `@nestjs/websockets` | 12.0.3 | Peers `@nestjs/common`/`core ^12`, `rxjs`, `reflect-metadata`. |
| `@nestjs/platform-ws` | 12.0.3 | Depends on `ws 8.21.3` (bundled); peers `@nestjs/websockets ^12`, `rxjs`. Add `@types/ws` for types. |
| `@nestjs/testing` | 12.0.3 | Peers `@nestjs/common`/`core ^12`; `platform-express` optional. Test-runner agnostic. |
| `@nestjs/config` | 12.0.0 | Peer `@nestjs/common ^11 \|\| ^12`. Depends on `@standard-schema/spec 1.1.0`, `dotenv 17.4.2`. |
| `@nestjs/schedule` | 12.0.2 | Peers `^11 \|\| ^12`; engines `node >=20.19.0`; depends on `cron 4.4.0`. |
| `@nestjs/throttler` | 6.5.0 (only release) | **Peer range stops at `^11`**, so pnpm reports an unmet peer on Nest 12. Nest 12 support is merged on master but unreleased: Version Packages PR #2677 proposes 6.6.0. Works at runtime in the probe. |
| `@nestjs/cli` | 12.0.1 | engines `node >= 20.11`. Depends on `typescript ~6.0.2`, but loads the **project's** `typescript` first and refuses TS 7. Optional peers `@swc/cli ^0.8.0`, `@swc/core ^1.15.18`. |
| `@nestjs/schematics` | 12.0.2 | Peer `typescript >=6.0.0`; engines `node ^22.22.3 \|\| ^24.15.0 \|\| >=26.0.0`. `nest g ... --dry-run` worked with TS 7 in the probe. |
| `typescript` | 7.0.2 (`latest`) | engines `node >=16.20.0`. Ships `tsc` only; no programmatic API until 7.1. |
| `@typescript/typescript6` | 6.0.2 | Fallback only: provides `tsc6` and the TS 6 compiler API via an npm alias. |
| `@swc/core` / `@swc/cli` | 1.16.2 / 0.8.1 | Needed only for the SWC paths. `@swc/core` needs an `allowBuilds` entry (postinstall). |
| `unplugin-swc` | 1.6.0 | Peer `@swc/core ^1.2.108`. Optional for Vitest (see decisions). |
| `vitest` | 5.0.1 | engines `node ^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; peer `vite ^6.4 \|\| ^7 \|\| ^8` (resolved `vite 8.3.0`, `rolldown 1.2.8`). Already pinned in the repo. |
| `zod` | 4.6.5 | Implements Standard Schema, and Nest 12's `StandardSchemaValidationPipe` accepted it directly. |
| `nestjs-zod` | 5.5.0 | Peer `@nestjs/common ^10 \|\| ^11`, so it does **not** support Nest 12. Not needed. |
| `helmet` | 8.3.0 | engines `node >=18.0.0`. |
| `cookie-parser` / `@types/cookie-parser` | 1.4.7 / 1.4.10 | Types peer `@types/express *`. |
| `@types/express` | 5.0.6 | Matches Express 5. |
| `ws` / `@types/ws` | 8.21.3 / 8.18.1 | `ws` comes through `@platform-ws`; only `@types/ws` is needed for type-only imports. |
| `reflect-metadata` / `rxjs` | 0.2.2 / 7.8.2 | Required peers. |
| `@types/node` | 24.13.4 | Match the Node 24 runtime (the repo already pins this). `latest` is 26.5.1; do not use it. |
| Docker base | `node:24.21.0-trixie-slim` (published 2026-09-09) | Debian 13. `24.21.0-bookworm-slim` also exists (see decisions). |

pnpm supply-chain note: with pnpm 12's default one-day `minimumReleaseAge`, installing today fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` for these packages, which all appeared in the probe:
- `@nestjs/common@12.0.3`
- `@nestjs/core@12.0.3`
- `@nestjs/platform-express@12.0.3`
- `@nestjs/platform-ws@12.0.3`
- `@nestjs/testing@12.0.3`
- `@nestjs/websockets@12.0.3`
- `@nestjs/cli@12.0.1`, but only if the CLI is used

Add them to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, which is decision A6, or pin 12.0.2 (published 2026-09-14T13:53Z). They age out of the window after about 2026-09-16T08:00Z.

## Verified APIs

### TypeScript 7.0.2 and Nest decorators

- TS 7 "does not yet expose a stable programmatic API, and so tools ... can only currently rely on TypeScript 6.0". For side-by-side use it recommends `"typescript": "npm:@typescript/typescript6@^6.0.2"`. Source: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- The typescript-go status table lists "Emit (JS output) | done" and "API | not ready": https://github.com/microsoft/typescript-go
- `--experimentalDecorators` and `--emitDecoratorMetadata` emit (`__decorate`, `__metadata`, `__param`) landed in typescript-go PR #2343, merged 2025-12-12: https://github.com/microsoft/typescript-go/pull/2343
- Experiment: TS 7.0.2 emitted `__metadata("design:paramtypes", [ConfigService])` and the app booted with working DI. Metadata for a probe constructor matched TS 6 semantics: `Dep`, `Dep | undefined` became `Object`, a string enum became `String`, an interface became `Object`, and a type-only `Request` became `Object`.
- Nest CLI 12.0.1 source (`lib/compiler/typescript-loader.js`) throws this error for `nest build`, `nest build -b swc` and `--type-check`: "The installed TypeScript version (7.0.2) does not expose the programmatic compiler API that the Nest CLI requires. ... Please install TypeScript 6 (e.g. "npm i -D typescript@^6") until then." TS 7.1 support is an open PR: https://github.com/nestjs/nest-cli/pull/3554
- Node's built-in type stripping cannot run Nest source: decorators "are not transformed and will result in a parser error". Parameter properties also need `--experimental-transform-types`. Source: https://nodejs.org/docs/latest-v24.x/api/typescript.html

The recommended `apps/api/tsconfig.json` passed the probe build with TS 7.0.2:

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "strictPropertyInitialization": false,
    "noUncheckedIndexedAccess": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

The Nest-generated ESM tsconfig uses the same `module`/`target`/decorator flags (https://docs.nestjs.com/migration-guide, "Switching your project to ESM"). With `verbatimModuleSyntax`, interfaces such as `OnGatewayInit` must be imported with `type`, while classes injected by type stay value imports.

### Nest 12 ESM and Node requirements

From https://docs.nestjs.com/migration-guide:
- "All core Nest packages now ship as ESM."
- Running Nest 12 needs Node "v20.19+, or v22.12+". The CLI schematics need "v22.22.3+, v24.15+, or v26+".
- Relative imports in ESM apps must use `.js` extensions (`import { AppModule } from './app.module.js'`).
- New projects: "ESM projects use Vitest by default".
- Express: "the Express adapter now drains in-flight requests on shutdown".
- `handleDisconnect` "can now receive the reason for the disconnection".

### Request validation with Zod 4 (built in, no nestjs-zod)

Sources: https://docs.nestjs.com/techniques/validation ("Using the built-in StandardSchemaValidationPipe") and https://docs.nestjs.com/migration-guide ("Route decorator schemas"). Zod API: https://zod.dev/api

```ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  dueAt: z.iso.datetime().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

@Controller('tasks')
export class TasksController {
  @Post()
  create(@Body({ schema: createTaskSchema }) body: CreateTaskInput) { /* body.title is trimmed */ }

  @Get(':id')
  findOne(@Param('id', { schema: z.coerce.number().int().positive() }) id: number) { /* id is a number */ }
}
// main.ts: app.useGlobalPipes(new StandardSchemaValidationPipe());
```

The docs say: "By default, the pipe returns the value produced by the schema." The probe confirmed trim and coercion. A bad body returned `{"message":["title: Too small: expected string to have >=1 characters"],"error":"Bad Request","statusCode":400}`. For responses, `StandardSchemaSerializerInterceptor` with `@SerializeOptions({ schema })` is documented in the migration guide.

### Env validation with `@nestjs/config`

Source: https://docs.nestjs.com/techniques/configuration ("Schema validation")

```ts
ConfigModule.forRoot({
  isGlobal: true,
  validationSchema: z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(10000),
  }),
});
```

The docs say: "The value returned by the schema is what `ConfigService` ends up serving." They also say unknown variables do not fail validation.

### main.ts (verified with TS 7 build, ESM, top-level await)

Sources:
- helmet: https://docs.nestjs.com/security/helmet
- cookies: https://docs.nestjs.com/techniques/cookies
- CORS: https://docs.nestjs.com/security/cors
- raw body: https://docs.nestjs.com/faq/raw-body
- shutdown hooks: https://docs.nestjs.com/fundamentals/lifecycle-events
- WsAdapter: https://docs.nestjs.com/websockets/adapter
- trust proxy: https://docs.nestjs.com/security/rate-limiting ("Proxies")
- Render port binding: https://render.com/docs/web-services

```ts
import 'reflect-metadata'; // optional: @nestjs/core and @nestjs/common import it too
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AuthWsAdapter } from './ws-auth.adapter.js';

const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3001';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1)); // hop count on Render: see open questions
app.use(helmet());                  // before any other app.use()
app.use(cookieParser());
app.enableCors({ origin: [webOrigin], credentials: true });
app.useGlobalPipes(new StandardSchemaValidationPipe());
app.useWebSocketAdapter(new AuthWsAdapter(app, new Set([webOrigin])));
app.enableShutdownHooks();          // SIGTERM -> onModuleDestroy -> beforeApplicationShutdown -> close -> onApplicationShutdown
await app.listen(Number(process.env.PORT ?? 10000), '0.0.0.0');
```

- Render: "Every Render web service must bind to a port on host `0.0.0.0`". Also: "The default value of `PORT` is `10000`". Source: https://render.com/docs/web-services
- Raw body for webhook signatures: `@Req() req: RawBodyRequest<Request>` then `req.rawBody` (a Buffer). Verified. Source: https://docs.nestjs.com/faq/raw-body
- `enableShutdownHooks(signals?, { useProcessExit?: boolean })`: by default Nest re-sends the signal to itself after the hooks (exit code 143). `useProcessExit: true` calls `process.exit(0)` instead. Source: `@nestjs/common` 12.0.3 `shutdown-hooks-options.interface.d.ts` and `@nestjs/core` `nest-application-context.js`.

### Raw WebSocket gateway with the ws adapter

Adapter facts:
- Nest docs: `WsAdapter` "is designed to handle messages in the `{ event: string, data: any }` format"; "`ws` library does not support namespaces ... mount multiple `ws` servers on different paths". Source: https://docs.nestjs.com/websockets/adapter
- Source of `@nestjs/platform-ws` 12.0.3 (`adapters/ws-adapter.js`):
  - For a gateway on the HTTP port, the adapter creates `new ws.Server({ noServer: true, ...gatewayOptions })`.
  - It routes `upgrade` by exact `pathname`, and destroys sockets on unknown paths.
  - It calls `wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws, req))`. So extra gateway options such as `verifyClient` and `maxPayload` reach `ws`, and `handleConnection(client, req)` receives the `IncomingMessage`.
- `ws` runs `verifyClient` inside `handleUpgrade`. The two-argument form `(info, cb)` supports async checks, and `cb(false, code, message)` aborts the handshake with that HTTP status. `info` is `{ origin, secure, req }`. Source: https://github.com/websockets/ws/blob/master/doc/ws.md. The same doc says "Use of `verifyClient` is discouraged. Rather handle client authentication in the `'upgrade'` event of the HTTP server". That cannot be done here without replacing the adapter's own upgrade listener (see decisions).
- Heartbeat pattern ("How to detect and close broken connections?"): https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
- Render has no maximum WebSocket duration, and recommends server pings plus client reconnect with exponential backoff: https://render.com/docs/websocket

`ws-auth.adapter.ts` uses DI for the session lookup and checks `Origin` because browsers send cookies on cross-site upgrades. It was verified to return 401 with no session, 403 for a bad origin, and to accept an authenticated socket:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import type { IncomingMessage } from 'node:http';
import { SessionService, type SocketUser } from './session.service.js';

export type UpgradeRequest = IncomingMessage & { user?: SocketUser };
type VerifyInfo = { origin: string; secure: boolean; req: UpgradeRequest };
type VerifyCallback = (ok: boolean, code?: number, message?: string) => void;

export class AuthWsAdapter extends WsAdapter {
  constructor(
    private readonly appContext: INestApplicationContext,
    private readonly allowedOrigins: ReadonlySet<string>,
  ) {
    super(appContext);
  }

  override create(port: number, options: Record<string, any> & { path?: string } = {}) {
    const sessions = this.appContext.get(SessionService);
    return super.create(port, {
      ...options,
      verifyClient: (info: VerifyInfo, cb: VerifyCallback) => {
        if (!this.allowedOrigins.has(info.origin)) return cb(false, 403, 'Forbidden');
        sessions
          .fromUpgradeRequest(info.req) // e.g. read the session cookie, look it up in D1
          .then((user) => {
            if (!user) return cb(false, 401, 'Unauthorized');
            info.req.user = user;
            cb(true);
          })
          .catch(() => cb(false, 500, 'Internal Server Error'));
      },
    });
  }
}
```

`events.gateway.ts` was verified for the heartbeat, a 1001 close on shutdown, and reply delivery. Lifecycle interfaces come from https://docs.nestjs.com/websockets/gateways and `@SkipThrottle` from https://docs.nestjs.com/security/rate-limiting:

```ts
import { Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer,
  type OnGatewayConnection, type OnGatewayDisconnect, type OnGatewayInit, type WsResponse,
} from '@nestjs/websockets';
import type { WebSocket, WebSocketServer as WsServer } from 'ws';
import type { UpgradeRequest } from './ws-auth.adapter.js';

type LiveSocket = WebSocket & { isAlive?: boolean; userId?: string };
const HEARTBEAT_MS = 30_000;

@SkipThrottle() // a global APP_GUARD ThrottlerGuard otherwise throws "res.header is not a function" on WS messages
@WebSocketGateway({ path: '/ws', maxPayload: 64 * 1024 })
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, BeforeApplicationShutdown
{
  private readonly logger = new Logger(EventsGateway.name);
  private heartbeat?: NodeJS.Timeout;

  @WebSocketServer()
  server: WsServer;

  afterInit(server: WsServer) {
    this.heartbeat = setInterval(() => {
      for (const client of server.clients as Set<LiveSocket>) {
        if (client.isAlive === false) { client.terminate(); continue; }
        client.isAlive = false;
        client.ping();
      }
    }, HEARTBEAT_MS);
    server.on('close', () => clearInterval(this.heartbeat));
  }

  handleConnection(client: LiveSocket, req: UpgradeRequest) {
    client.isAlive = true;
    client.userId = req.user?.userId; // set by AuthWsAdapter.verifyClient before the 101 response
    client.on('pong', () => { client.isAlive = true; });
  }

  handleDisconnect(client: LiveSocket, reason?: string) {
    this.logger.log(`disconnected ${client.userId} ${reason ?? ''}`);
  }

  // Runs before app.close() terminates sockets: send 1001 so clients reconnect promptly.
  async beforeApplicationShutdown() {
    clearInterval(this.heartbeat);
    const closing = [...this.server.clients].map(
      (c) => new Promise<void>((resolve) => { c.once('close', () => resolve()); c.close(1001, 'server restarting'); }),
    );
    await Promise.race([Promise.all(closing), new Promise((r) => setTimeout(r, 5_000))]);
  }

  @SubscribeMessage('ping')
  onPing(@MessageBody() data: unknown, @ConnectedSocket() client: LiveSocket): WsResponse<unknown> {
    return { event: 'pong', data: { echo: data, userId: client.userId } };
  }
}
```

The client sends `JSON.stringify({ event: 'ping', data })` and receives `{"event":"pong","data":{...}}`. Without `beforeApplicationShutdown`, `WsAdapter.close()` calls `terminate()`, and clients see code 1006.

### Rate limiting

Source: https://docs.nestjs.com/security/rate-limiting

```ts
ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
// providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
```

The WebSockets section says: "Guard cannot be registered with the `APP_GUARD` or `app.useGlobalGuards()`". It also shows a `WsThrottlerGuard` that overrides `handleRequest`. For proxies, it recommends `app.set('trust proxy', ...)` and optionally overriding `getTracker`. The probe verified 200 followed by 429s on a 3-per-minute limit.

### Testing with Vitest 5

Nest's recipe (https://docs.nestjs.com/recipes/swc, "Vitest") installs `vitest unplugin-swc @swc/core @vitest/coverage-v8` and configures:

```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, root: './' },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

unplugin-swc infers `jsc.transform.legacyDecorator` and `decoratorMetadata` from tsconfig `experimentalDecorators` and `emitDecoratorMetadata` (its README).

Vite 8 transpiles with Oxc and reads tsconfig `experimentalDecorators`. On `emitDecoratorMetadata`, the Vite docs say: "This option is only partially supported. Full support requires type inference by the TypeScript compiler, which is not supported." Source: https://vite.dev/guide/features

Probe results with Vitest 5.0.1:
- **Both** configs passed `Test.createTestingModule` DI plus e2e tests over HTTP and a real WebSocket.
- **SWC** metadata differed from tsc for a type-only `import type { Request } from 'express'`: it emitted the global Fetch `Request` class, where tsc emits `Object`.
- **Oxc** matched tsc on every probed parameter except the string enum (both SWC and Oxc emitted the enum object; tsc emits `String`).

This minimal config needs no plugin:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.spec.ts'], environment: 'node' } });
```

For e2e tests, `await app.listen(0, '127.0.0.1'); const base = await app.getUrl();` then `fetch(base + '/tasks')`, and `new WebSocket(base.replace('http', 'ws') + '/ws', { origin, headers: { cookie } })` from `ws`. Verified; `supertest` is not required.

### Build and dev loop without the Nest CLI

- `tsc -p tsconfig.json` with TS 7.0.2 emits a runnable ESM `dist/`. The probe built in about 1.2 s.
- `tsc --watch --preserveWatchOutput` re-emitted on change (verified).
- `node --watch-path=dist --enable-source-maps dist/main.js` restarts on emitted changes. Source: https://nodejs.org/docs/latest-v24.x/api/cli.html
- Fallback if Nest CLI plugins (for example `@nestjs/swagger`) are ever needed: alias `typescript` to `npm:@typescript/typescript6@6.0.2` in `apps/api` and use `nest build -b swc --type-check` (verified). For ESM output, SWC needs a `.swcrc` with `"module": { "type": "es6" }`, because the CLI default is `commonjs` (source `lib/compiler/defaults/swc-defaults.js`; verified). Known issue: mixed TS 6 and TS 7 workspaces break CLI plugin resolution under pnpm: https://github.com/nestjs/nest-cli/issues/3549

### pnpm deploy for the image

Source: https://pnpm.io/cli/deploy
- "Since v12.2.0, `pnpm deploy` no longer requires `injectWorkspacePackages`."
- The documented usage is `pnpm --filter=<deployed project name> --prod deploy <target directory>`.
- Files copied: the package's `files` field wins, then `.npmignore`, then `.gitignore`. Set `"files": ["dist"]` so a `.gitignore` entry for `dist` can never drop the build.

The probe ran `pnpm install --frozen-lockfile --filter "@symplist/api..."`, then build, then `--prod deploy`. The result held only prod deps and started correctly.

### Render

- Blueprint fields, verified against the page's example `render.yaml`:
  - `type: web` and `runtime: node | docker | image | ...`. `runtime` "replaces the deprecated `env` field".
  - `plan` IDs such as `0.5c-512mb` (the default for new services) and `1c-2g`.
  - `region` is one of `oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`.
  - `dockerfilePath` defaults to `./Dockerfile`, and `dockerContext` defaults to the repo root.
  - `dockerCommand` defaults to the Dockerfile `CMD`.
  - `healthCheckPath` is for web services only.
  - `maxShutdownDelaySeconds` is 1 to 300, default 30.
  - `autoDeployTrigger: commit | checksPass | off` replaces `autoDeploy`.
  - `buildFilter` takes `paths` and `ignoredPaths` globs relative to the repo root.
  - `envVars` accepts `value`, `generateValue: true`, `sync: false` (prompted only at initial Blueprint creation), `fromGroup`, `fromService` and `fromDatabase`.
  - Source: https://render.com/docs/blueprint-spec
- Native runtimes "run on Debian 12.x, 'bookworm'" and list `git` as "Available both during builds and at runtime". Docker is advised when "You want full control over which tools and libraries are present". Source: https://render.com/docs/native-runtimes
- The Render Node version comes from `NODE_VERSION`, then `.node-version`, `.nvmrc`, or `engines`. The docs say "Always include an upper bound". The default for new services is 24.14.1, which is below the repo's `>=24.15.0`. Source: https://render.com/docs/node-version
- Docker on Render:
  - Render builds with BuildKit and supports multi-stage builds.
  - Env vars are "automatically" translated to Docker build arguments, so never reference secrets as build args.
  - "pulling an image with a mutable tag ... might result in a build that uses a cached, less recent version".
  - Source: https://render.com/docs/docker
- Health checks: "2xx or 3xx status code within five seconds". A running instance failing checks for 15 s is removed from routing, and it is restarted after 60 s. Source: https://render.com/docs/health-checks
- Deploys: "After 60 seconds, Render sends a SIGTERM signal to your app's process on the original instance". The process is sent SIGKILL after the shutdown delay (default 30 s). Source: https://render.com/docs/deploys
- Client IP: "Because traffic passes through Cloudflare and Render's load balancers, your app sees the proxy's IP by default. To get the real client IP, read the `x-forwarded-for` header." Source: https://render.com/articles/how-render-handles-ddos-attacks

Dockerfile (`apps/api/Dockerfile`, context = repo root). What was verified locally:
- The same base images, apt packages, pnpm install, build and `deploy` steps built and ran. The local image used an unfiltered `pnpm install`; the `--filter "@symplist/api..."` install was verified separately on the host.
- `git 2.47.3` was present, and SIGTERM stopped the container in under 1 s.
- The cache mount line needs BuildKit, which Render uses; it was not exercised locally.

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24.21.0-trixie-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@12.4.2
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@symplist/api..."
RUN pnpm --filter @symplist/api build
RUN pnpm --filter @symplist/api --prod deploy /prod/api

FROM node:24.21.0-trixie-slim AS runtime
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/api ./
USER node
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
```

Base image facts:
- docker-node `versions.json` lists `bookworm`, `bookworm-slim`, `trixie` and `trixie-slim` variants for Node 24, with `"debian-default": "bookworm"`. Node 24 enters maintenance 2026-10-20 and ends 2028-04-30. Source: https://github.com/nodejs/docker-node
- Debian: 13 "trixie" is current stable. Debian 12 "bookworm" reached EOL on 2026-07-11, with LTS until 2028-06-30. Source: https://www.debian.org/releases/
- pnpm's own Docker guide uses `ghcr.io/pnpm/pnpm:12` + `pnpm runtime set node 24 -g`: https://pnpm.io/docker. Installing `pnpm@12.4.2` from npm (Node 22.13+) is also supported: https://pnpm.io/installation

`render.yaml` (Blueprint syntax verified; values marked "build default" need owner confirmation):

```yaml
services:
  - type: web
    name: symplist-api
    runtime: docker
    plan: 1c-2g                 # build default
    region: virginia            # build default
    dockerfilePath: ./apps/api/Dockerfile
    dockerContext: .
    healthCheckPath: /healthz
    autoDeployTrigger: commit   # A2: merges to main auto-deploy
    numInstances: 1             # A2: single always-on instance
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
      - key: WEB_ORIGIN
        value: https://app.example.com   # placeholder
      - key: TRUST_PROXY_HOPS
        value: 1
      - key: SESSION_SECRET
        generateValue: true
      - key: CLOUDFLARE_API_TOKEN
        sync: false
```

Do not set `PORT`: Render provides 10000, and `main.ts` reads `process.env.PORT`. Do not add Blueprint env vars whose names match Dockerfile `ARG`s, because Render passes every env var as a build arg.

## Decisions and recommendations

1. **NestJS 12.0.3 across all `@nestjs/*` 12.x packages, ESM app.** Use `"type": "module"`, `module: nodenext`, `.js` relative imports, and top-level `await` in `main.ts`. This matches the ESM-only Nest 12 packages and the ESM `apps/worker`. Exclude today's 12.0.3 releases from `minimumReleaseAge`, or pin 12.0.2 for one day.
2. **Express, not Fastify.** Reasons:
   - It is Nest's default, and `@nestjs/core`/`@nestjs/testing` list `platform-express` as their optional peer.
   - `helmet` and `cookie-parser` work as documented middleware (Fastify needs `@fastify/helmet` and `@fastify/cookie` plugins).
   - The Express adapter drains in-flight requests on shutdown in v12.
   - Node `req`/`res` interop is simplest for the incoming MCP Streamable HTTP endpoint and OAuth routes.

   Fastify's speed is not a bottleneck for a closed beta on one instance.
3. **TypeScript 7.0.2 everywhere; do not use the Nest CLI for build or start.** TS 7 `tsc` supports and correctly emits `experimentalDecorators` + `emitDecoratorMetadata`, and the probe proved a real Nest 12 app runs on its output. The Nest CLI is the only piece that needs TS 6, because it needs the compiler API. Setup:
   - `apps/api` scripts: `build: tsc -p tsconfig.json`, `typecheck: tsc --noEmit -p tsconfig.test.json` (covering `src` and `test`), `start: node --enable-source-maps dist/main.js`.
   - Dev loop: `tsc --watch` + `node --watch-path=dist dist/main.js`.
   - Skip `@nestjs/cli`, `@swc/cli` and `@swc/core` entirely. Generators are optional: `nest g service <name> --dry-run` worked from a locally installed CLI 12.0.1 with TS 7 present, or write files by hand.
   - Do **not** use tsx, esbuild or Node type stripping to run Nest source, because they cannot emit decorator metadata or decorators.
   - Fallback if a CLI plugin becomes necessary: `apps/api` devDependency `"typescript": "npm:@typescript/typescript6@6.0.2"` plus the SWC builder with `.swcrc` `module.type: "es6"`. Be aware of the mixed-TS-version pnpm issue (nest-cli #3549), and revisit when nest-cli ships TS 7.1 API support (PR #3554).
4. **Validation: Nest 12 built-in `StandardSchemaValidationPipe` with Zod 4.6.5**, registered globally. Use schemas on `@Body/@Query/@Param({ schema })`. Do not add `nestjs-zod` (no Nest 12 peer), `class-validator` or `class-transformer`. Share Zod schemas with the web app from a workspace package if needed. Validate env with `ConfigModule.forRoot({ validationSchema: z.object(...) })`.
5. **Tests: Vitest 5.0.1 using Vite 8's built-in Oxc decorator transform (no SWC plugin)**, plus `@nestjs/testing`. Include one guard test asserting `Reflect.getMetadata('design:paramtypes', SomeProvider)` so a transform regression fails loudly. This keeps the dependency set equal to `apps/worker` (no `@swc/core` build approval), and its metadata was closer to tsc than SWC's in the probe. If a DI case breaks under Oxc, switch to Nest's documented `unplugin-swc@1.6.0` + `@swc/core@1.16.2` config (verified working too). Run e2e tests against `app.listen(0)` with `fetch` and `ws`.
6. **WebSockets: `@nestjs/platform-ws` `WsAdapter` on the HTTP port at `/ws`.**
   - Authenticate during the upgrade with an `AuthWsAdapter` subclass. It injects `verifyClient` (async callback form), checks `Origin` against the web origin allowlist, resolves the session cookie via DI, and attaches the user to `req`. `handleConnection(client, req)` reads that user.
   - This rejects before the 101 response, so no unauthenticated message can race an async `handleConnection`.
   - Implement heartbeats with the `ws` ping/pong `isAlive` pattern every 30 s. Browsers answer pings automatically, but the web client still needs reconnect with exponential backoff (Render docs).
   - Close with 1001 in `beforeApplicationShutdown`. Set `maxPayload`.
   - Put `@SkipThrottle()` on every gateway. If per-socket message rate limits are needed, count messages in the gateway rather than using the HTTP `ThrottlerGuard`.
7. **Security middleware:** apply `helmet()` first, then `cookie-parser`, then `enableCors({ origin: [WEB_ORIGIN], credentials: true })`. Use `rawBody: true` for webhook signature checks. Size JSON body limits via `app.useBodyParser('json', { limit })` where needed.
8. **Rate limiting: `@nestjs/throttler` 6.5.0 now** (in-memory storage is fine for one instance). Silence the peer mismatch in `pnpm-workspace.yaml`; this was verified to clear `pnpm peers check`:

   ```yaml
   peerDependencyRules:
     allowedVersions:
       '@nestjs/throttler>@nestjs/common': '12'
       '@nestjs/throttler>@nestjs/core': '12'
   ```

   Upgrade to 6.6.0 when it is published, then drop the rule. Use the `forRoot([...])` array form. The `forRootAsync` types degrade to `any` under Nest 12 because of a deep import (throttler PR #2672).
9. **Shutdown:** call `app.enableShutdownHooks()` and keep the default signal re-raise. Run under `tini` in Docker so PID 1 signal semantics are standard. Set `maxShutdownDelaySeconds: 60`. Agent runs are durable in Trigger.dev, so the API only needs to finish in-flight HTTP work and close sockets.
10. **Render: Docker runtime, not the native Node runtime.** The native runtime does include `git` at runtime and would work. Docker is preferred because git bundles are a hard dependency, so the app should pin its own environment:
    - exact Node `24.21.0`, pnpm `12.4.2` and Debian `git`;
    - Debian 13, instead of Render's native Debian 12, which is past regular security support;
    - no dependence on which pnpm and Node the native image preinstalls or resolves (the Render default Node 24.14.1 is below the repo floor).

    Base image: `node:24.21.0-trixie-slim` over `bookworm-slim`, for the same Debian support reason. Pin exact tags because Render caches mutable tags. Use `healthCheckPath: /healthz`, a cheap endpoint with no auth, throttling or D1 call. D1 connectivity can go in a separate readiness route if wanted.
11. **`@nestjs/schedule`: do not use for product jobs.** Trigger.dev owns schedules; in-process timers die with a single Render instance. It is acceptable only inside the local no-Trigger fallback executor (decision A1). `ScheduleModule.forRoot()` boots on Nest 12.

## Risks and open questions

- **Nest CLI and TS 7:** `nest build/start` cannot run with TS 7.0.2. Anything that needs the compiler API (CLI plugins such as the `@nestjs/swagger` metadata plugin, `fork-ts-checker`, `ts-jest`) is unavailable until TS 7.1 and nest-cli PR #3554 ship. The plan avoids these; adding OpenAPI generation later would need a reassessment.
- **Decorator metadata fidelity in tests:** Oxc and SWC both lack type information (Vite docs say "only partially supported"). Keep DI to class-typed constructor params imported as values. Avoid `import type` for injected classes and circular type-only references, and use `@Inject(token)` for interfaces and aliases. The guard test catches regressions.
- **Throttler on Nest 12 is unreleased:**
  - 6.5.0 runs, but peer ranges and `forRootAsync` types are off until 6.6.0 is out (https://github.com/nestjs/throttler/issues/2669, https://github.com/nestjs/throttler/pull/2677).
  - A global `APP_GUARD` also hits gateway handlers and throws unless `@SkipThrottle()` is present (verified).
- **`trust proxy` hop count on Render is unverified.** Traffic passes Cloudflare and Render's load balancer. It is not documented whether Render overwrites or appends `X-Forwarded-For`, so `req.ip` could be a proxy IP (hops too low) or client-spoofable (hops too high / `true`). At first deploy, log `x-forwarded-for`, `req.ips` and `req.ip` from a debug route, then set `TRUST_PROXY_HOPS` or a custom `getTracker`.
- **`verifyClient` is "discouraged" by `ws`,** though it is supported and works. The documented alternative (auth in the HTTP `upgrade` event) would mean overriding `WsAdapter.ensureHttpServerExists`, a protected internal. Re-check the adapter on each Nest minor.
- **Same-site cookies for WS auth:** the web app is on Vercel and the API on Render. Cookie auth on the upgrade needs the API cookie to reach `wss://` (custom API subdomain on the same site, `SameSite` and `Secure` settings), plus the `Origin` allowlist. This depends on the auth design and domain choice, which are outside this topic.
- **Single instance:** one Render instance means every deploy drops all sockets (1001 then reconnect), and in-memory throttler and heartbeat state resets. That is acceptable for a closed beta. Multiple instances would need shared rate-limit storage and a pub/sub fan-out, because Render assigns connections to random instances.
- **SIGTERM exit code:** Nest re-raises the signal (exit 143) unless `useProcessExit: true` (exit 0). Render only requires exit before the delay; confirm that a 143 exit is not surfaced as a failure in Render events. With node as PID 1 and no `tini`, the re-raised signal is ignored; the probe still exited because the event loop drained, but an open handle would then hang until SIGKILL.
- **Render build for linux/amd64 was not exercised.** The local image was arm64 with the classic builder. The TS 7 native binary and pnpm 12 native binary are per-platform optional deps and should resolve on amd64. The first Render deploy is the check.
- **Open (owner):** Render `plan` and `region` (build defaults `1c-2g` and `virginia`), and whether the API itself runs git operations or only Trigger tasks do. The latter would allow dropping `git` from the API image, although the requirement says the API needs it.
- **Release window:** Nest 12.0.3 and Vitest 5.0.1 were published today. Watch for 12.0.x patch churn (12.0.2 and 12.0.3 both landed within about 18 hours).
