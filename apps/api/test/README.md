# API test harness

Shared support for api tests (architecture §17): boot the real Nest application with local drivers
and fakes, call it over real HTTP on an ephemeral port, and inspect what it stored and logged.
Feature tests live beside their code as `src/**/*.test.ts`; the harness itself is tested in
`test/harness.test.ts`.

## Booting

```ts
import { afterAll, beforeAll, it, expect } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { TasksModule } from "./tasks.module.ts";

let app: TestApp;
beforeAll(async () => {
  app = await bootTestApp();
});
afterAll(() => app.close());
```

`bootTestApp(options)` gives each app:

- a validated `NODE_ENV=test` configuration with fresh generated secrets (`testApiEnv(overrides)`), so
  config rules run exactly as in production code paths;
- `DATA_DRIVER=local`: a SQLite file and an object store in a new temporary directory
  (`app.dataDir`), with every migration applied at startup and the directory removed by `close()`;
- a `FakeClock` (`app.clock`) bound to `CLOCK`, so sessions, caches, idempotency expiry and the per-IP
  buckets move only when the test calls `app.clock.advance(ms)`;
- a `FakeTriggerClient` (`app.trigger`) bound to `TRIGGER_CLIENT`;
- a capture email transport (`app.email`) bound to `EMAIL_TRANSPORT`;
- captured structured logs (`app.logs`) at `debug` level.

| Option | Use |
| --- | --- |
| `env` | Environment overrides, for example `{ BETA_ACCESS_REQUIRED: "false", TRUST_PROXY_HOPS: "1" }`. Pass the same full `testApiEnv()` result to two apps when they must share secrets. |
| `imports` | Extra modules, typically a probe module with test controllers. Every controller route still needs `@RouteClass` or the app refuses to boot. |
| `providers` | Extra global providers, such as fakes for the realtime seams (`REALTIME_ACCESS_NOTIFIER`, `RUN_CANCELLER`, `REALTIME_SHUTDOWN`) or `ACCOUNT_DELETION_EFFECTS`. |
| `overrides` | `[{ token, value }]` replacing existing providers after the module graph is built. |
| `clock`, `trigger` | Reuse a clock or Trigger client, for example across two apps. |
| `dataDir` | Reuse a data directory to simulate a restart or a second instance (the caller then removes it). |
| `logLevel` | Minimum captured level; defaults to `debug`. |

The feature modules already imported by `AppModule` are part of every test app, so a feature test
usually needs no `imports` at all.

## Users, sessions and requests

```ts
const { id, session } = await app.createSignedInUser("admitted");
const response = await app.post("/v1/tasks", {
  session,
  body: { title: "Plan trip" },
  idempotencyKey: "0190f3c2-5b1e-7a44-9e0b-1f2a3b4c5d6e",
});
expect(response.status).toBe(201);
```

- `createUser({ state, email })` inserts a user with an account data key. States: `unverified`,
  `locked`, `admitted`, `relocked`, `suspended`, `admin`, `deleting` (no key: it was shredded, and
  provisioning never creates one for an account being deleted).
- `signIn(userId)` creates a real session and returns `{ userId, sessionId, token, cookie, csrf }`.
- `createSignedInUser(state)` does both.
- `request(method, path, options)` and the `get`/`post` shortcuts send the session cookie; on unsafe
  methods they also send `Origin: WEB_ORIGIN` and the session's `X-Symplist-CSRF` token. Pass
  `origin: null` or `csrf: null` to omit them, `csrf: "1"` for `pre_session` routes, and
  `shareHost: true` to address the share host (`http://127.0.0.1:<port>`; the api host is
  `http://localhost:<port>`).
- `accessState(userId)` reads the user's access fields fresh from D1.

## Inspecting effects

- `app.db`, `app.objects`, `app.keys`, `app.sessions`, `app.accountKeys` and `app.inject(token)` give
  direct access to the providers of the running app.
- `scanDatabaseFor(value)` returns every `table.column` containing a value, and `scanObjectsFor(value)`
  every stored object file containing it. Use them for the one-time secret scans (§6.1) and
  plaintext leakage checks; `app.logs.text()` covers logs.
- `app.logs.events("http.request")` returns parsed log entries for an event.

## Rules for feature tests

- Close every app (`afterEach`/`afterAll`); tests run in parallel workers and never share ports,
  cookies or data directories.
- Advance time with `app.clock`, never real timers, when behavior depends on time.
- Spy on `app.db.batch` to prove that a check happens before any D1 access.
- Per-IP buckets live in each app's memory and every test request comes from one address: more than
  60 lookups of session cookies that name no session at all (random tokens, not revoked or expired
  sessions) within 10 minutes hit the `session_unknown` bucket (503 `rate.limited`). Advance
  `app.clock` or boot a fresh app.
- Tests that need live providers are gated by `LIVE_*` flags and skipped with a visible reason.
