import { randomBytes, randomUUID } from "node:crypto";
import { type Dirent, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectionToken, ModuleMetadata, Provider } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { type ApiConfig, apiSecretFamilies, loadApiConfig } from "@symplist/config/api";
import { csrfHeader, idempotencyKeyHeader, normalizeEmail } from "@symplist/contracts";
import {
  type AccessState,
  accessStateFromRow,
  loadAccessStateStatement,
} from "@symplist/core/access";
import type { AccountKeyStore } from "@symplist/core/account";
import type { KeyProvider } from "@symplist/crypto";
import { type DbClient, type DbRow, int, sql, uuidv7 } from "@symplist/db";
import { type CaptureEmailTransport, createCaptureEmailTransport } from "@symplist/email";
import type { ObjectStore } from "@symplist/storage";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { AppModule } from "../src/app.module.ts";
import { configureApp, initializeApp } from "../src/app.ts";
import { ACCOUNT_KEYS } from "../src/common/access/access.providers.ts";
import { SessionService } from "../src/common/auth/session.service.ts";
import { cookieNames } from "../src/common/auth/session-cookies.ts";
import { CLOCK } from "../src/common/clock.ts";
import type { LogLevel, LogSink } from "../src/common/logging/logger.ts";
import { TRIGGER_CLIENT } from "../src/common/seams.ts";
import { KEY_PROVIDER } from "../src/infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../src/infra/db/db.providers.ts";
import { EMAIL_TRANSPORT } from "../src/infra/email/email.providers.ts";
import { OBJECT_STORE } from "../src/infra/storage/storage.providers.ts";

/** A fresh generated secret: 32 random bytes as base64url (§4.5). */
export function generatedSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A valid `NODE_ENV=test` api environment with local drivers and fresh secrets. The origins mirror
 * local development: web `localhost:3000`, api `localhost`, share host `127.0.0.1` (§16.3).
 */
export function testApiEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const families = Object.fromEntries(
    apiSecretFamilies.flatMap((family) => [
      [`${family}_1`, generatedSecret()],
      [`${family}_CURRENT`, "1"],
    ]),
  );
  return {
    NODE_ENV: "test",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:4000",
    WS_ORIGIN: "ws://localhost:4000",
    ARTIFACT_ORIGIN: "http://127.0.0.1:4000",
    TRUST_PROXY_HOPS: "0",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    AI_PROVIDER_MODE: "scripted",
    EMAIL_FROM_SECURITY: "Symplist <security@example.test>",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@example.test>",
    ...families,
    ...overrides,
  };
}

/** Structured log lines written by the app under test. */
export class CapturedLogs implements LogSink {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  /** Every line parsed as JSON. */
  entries(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Lines whose `event` equals `event`. */
  events(event: string): Record<string, unknown>[] {
    return this.entries().filter((entry) => entry.event === event);
  }

  /** All output as one string, for asserting that a value never appears. */
  text(): string {
    return this.lines.join("\n");
  }

  clear(): void {
    this.lines.length = 0;
  }
}

export interface TestAppOptions {
  /** Environment overrides applied on top of {@link testApiEnv}. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to a `FakeClock` at 2026-09-15T09:00:00Z. */
  readonly clock?: FakeClock;
  /** Defaults to a fresh `FakeTriggerClient` on the same clock, bound to `TRIGGER_CLIENT`. */
  readonly trigger?: FakeTriggerClient;
  /** Extra global providers (realtime seams, feature fakes). */
  readonly providers?: readonly Provider[];
  /** Extra modules, such as probe controllers. */
  readonly imports?: NonNullable<ModuleMetadata["imports"]>;
  /** Replaces providers by token after the module graph is built. */
  readonly overrides?: ReadonlyArray<{ readonly token: InjectionToken; readonly value: unknown }>;
  /** Reuse a data directory (to simulate a restart); a fresh temporary one otherwise. */
  readonly dataDir?: string;
  /** Defaults to `debug`, so every event is captured. */
  readonly logLevel?: LogLevel;
}

export type TestUserState =
  | "unverified"
  | "locked"
  | "admitted"
  | "relocked"
  | "suspended"
  | "admin"
  | "deleting";

export interface TestUser {
  readonly id: string;
  readonly email: string;
}

export interface TestSession {
  readonly userId: string;
  readonly sessionId: string;
  /** The raw session token. */
  readonly token: string;
  /** A `Cookie` header value carrying the session cookie. */
  readonly cookie: string;
  /** The session-bound `X-Symplist-CSRF` token. */
  readonly csrf: string;
}

export interface RequestOptions {
  /** Sends the session cookie and, on unsafe methods, the CSRF token. */
  readonly session?: TestSession;
  /** A JSON body. */
  readonly body?: unknown;
  /** `Origin`; defaults to `WEB_ORIGIN` on unsafe methods. `null` omits it. */
  readonly origin?: string | null;
  /** `X-Symplist-CSRF`; defaults to the session's token on unsafe methods. `null` omits it. */
  readonly csrf?: string | null;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Send to the share host instead of the api host. */
  readonly shareHost?: boolean;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed JSON body; throws when the body is not JSON. */
  json<T = unknown>(): T;
}

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A booted api on an ephemeral port with local drivers, fakes and helpers. */
export class TestApp {
  readonly app: NestExpressApplication;
  readonly config: ApiConfig;
  readonly clock: FakeClock;
  readonly trigger: FakeTriggerClient;
  readonly email: CaptureEmailTransport;
  readonly logs: CapturedLogs;
  readonly dataDir: string;
  /** `http://localhost:<port>`: the api host. */
  readonly baseUrl: string;
  /** `http://127.0.0.1:<port>`: the share host. */
  readonly shareBaseUrl: string;
  private readonly ownsDataDir: boolean;
  private closed = false;
  private userSequence = 0;

  constructor(init: {
    app: NestExpressApplication;
    config: ApiConfig;
    clock: FakeClock;
    trigger: FakeTriggerClient;
    email: CaptureEmailTransport;
    logs: CapturedLogs;
    dataDir: string;
    ownsDataDir: boolean;
    port: number;
  }) {
    this.app = init.app;
    this.config = init.config;
    this.clock = init.clock;
    this.trigger = init.trigger;
    this.email = init.email;
    this.logs = init.logs;
    this.dataDir = init.dataDir;
    this.ownsDataDir = init.ownsDataDir;
    this.baseUrl = `http://localhost:${init.port}`;
    this.shareBaseUrl = `http://127.0.0.1:${init.port}`;
  }

  /** Resolves a provider of the app by token or class. */
  inject<T>(token: InjectionToken): T {
    return this.app.get<T>(token, { strict: false });
  }

  get db(): DbClient {
    return this.inject<DbClient>(DB_CLIENT);
  }

  get objects(): ObjectStore {
    return this.inject<ObjectStore>(OBJECT_STORE);
  }

  get keys(): KeyProvider {
    return this.inject<KeyProvider>(KEY_PROVIDER);
  }

  get sessions(): SessionService {
    return this.inject<SessionService>(SessionService);
  }

  get accountKeys(): AccountKeyStore {
    return this.inject<AccountKeyStore>(ACCOUNT_KEYS);
  }

  /** The session cookie name for this runtime (`sym_session` outside production). */
  get sessionCookieName(): string {
    return cookieNames(this.config).session;
  }

  /**
   * Creates a user in a given access state, with an account data key, in one batch. `admitted` is
   * verified and unlocked; `admin` adds the role.
   */
  async createUser(
    options: { readonly state?: TestUserState; readonly email?: string } = {},
  ): Promise<TestUser> {
    const state = options.state ?? "admitted";
    this.userSequence += 1;
    const now = this.clock.now();
    const id = uuidv7(now);
    const email = normalizeEmail(
      options.email ?? `user${this.userSequence}.${randomUUID().slice(0, 8)}@example.test`,
    );
    const verified = state === "unverified" ? null : int(now);
    const betaState =
      state === "locked" || state === "unverified"
        ? "locked"
        : state === "relocked"
          ? "relocked"
          : "unlocked";
    await this.db.batch([
      sql(
        `INSERT INTO users (id, email, email_verified_at, beta_state, suspended_at, role, onboarding_step,
           deletion_state, deletion_requested_at, created_at, updated_at, write_id)
         VALUES (:id, :email, :verified, :beta, :suspended, :role, 'done', :deletion, :deleted_at, :now, :now, :w)`,
        {
          id,
          email,
          verified,
          beta: betaState,
          suspended: state === "suspended" ? int(now) : null,
          role: state === "admin" ? "admin" : "member",
          deletion: state === "deleting" ? "deleting" : "none",
          deleted_at: state === "deleting" ? int(now) : null,
          now: int(now),
          w: uuidv7(now),
        },
      ),
      this.accountKeys.provisionStatement({ userId: id, now }),
    ]);
    return { id, email };
  }

  /** Creates a live session for a user and returns its cookie and CSRF token. */
  async signIn(userId: string): Promise<TestSession> {
    const created = await this.sessions.store.create({ userId, now: this.clock.now() });
    if (!created) throw new Error("The user cannot sign in (missing or being deleted)");
    return {
      userId,
      sessionId: created.sessionId,
      token: created.token,
      cookie: `${this.sessionCookieName}=${created.token}`,
      csrf: this.sessions.csrfToken(created.sessionId),
    };
  }

  /** Creates a user in `state` and signs them in. */
  async createSignedInUser(
    state: TestUserState = "admitted",
  ): Promise<TestUser & { readonly session: TestSession }> {
    const user = await this.createUser({ state });
    return { ...user, session: await this.signIn(user.id) };
  }

  /** The user's access fields read fresh from D1. */
  async accessState(userId: string): Promise<AccessState | null> {
    const row = await this.db.first(loadAccessStateStatement(userId));
    return row ? accessStateFromRow(row) : null;
  }

  /** Sends an HTTP request with the platform's headers filled in. */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> {
    const upper = method.toUpperCase();
    const headers = new Headers(options.headers);
    if (options.session) {
      const existing = headers.get("cookie");
      headers.set(
        "cookie",
        existing ? `${existing}; ${options.session.cookie}` : options.session.cookie,
      );
    }
    if (unsafeMethods.has(upper)) {
      const origin = options.origin === undefined ? this.config.WEB_ORIGIN : options.origin;
      if (origin !== null) headers.set("origin", origin);
      const csrf = options.csrf === undefined ? options.session?.csrf : options.csrf;
      if (csrf !== undefined && csrf !== null) headers.set(csrfHeader, csrf);
    } else if (options.origin) {
      headers.set("origin", options.origin);
    }
    if (options.idempotencyKey !== undefined)
      headers.set(idempotencyKeyHeader, options.idempotencyKey);
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const base = options.shareHost ? this.shareBaseUrl : this.baseUrl;
    const response = await fetch(`${base}${path}`, {
      method: upper,
      headers,
      redirect: "manual",
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: <T>() => JSON.parse(text) as T,
    };
  }

  get(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this.request("GET", path, options);
  }

  post(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this.request("POST", path, options);
  }

  /** Every `table.column` of every D1 table whose text contains `needle` (§6.1 secret scans). */
  async scanDatabaseFor(needle: string): Promise<string[]> {
    const tables = await this.db.all<{ name: string }>(
      sql(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ),
    );
    const hits: string[] = [];
    for (const { name } of tables) {
      if (!/^[a-z0-9_]+$/.test(name)) continue;
      const rows = await this.db.all<DbRow>(sql(`SELECT * FROM "${name}"`));
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (value !== null && String(value).includes(needle)) hits.push(`${name}.${column}`);
        }
      }
    }
    return hits;
  }

  /** Every stored object file (bodies and metadata sidecars) whose bytes contain `needle`. */
  scanObjectsFor(needle: string): string[] {
    const root = join(this.dataDir, "objects");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (readFileSync(path).includes(Buffer.from(needle))) hits.push(path);
      }
    };
    walk(root);
    return hits;
  }

  /** Closes the app and removes its temporary data directory. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.app.close();
    if (this.ownsDataDir) rmSync(this.dataDir, { recursive: true, force: true });
  }
}

/**
 * Boots the api for a test: validated test configuration, local SQLite in a temporary directory with
 * migrations applied, the local object store, a capture email transport, a fake clock and a fake
 * Trigger client, listening on an ephemeral port. Close it in `afterEach`/`afterAll`.
 */
export async function bootTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = loadApiConfig(testApiEnv(options.env));
  const clock = options.clock ?? new FakeClock();
  const trigger = options.trigger ?? new FakeTriggerClient({ clock });
  const email = createCaptureEmailTransport();
  const logs = new CapturedLogs();
  const ownsDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "symplist-api-test-"));

  let builder = Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config,
        clock,
        localDataDir: dataDir,
        logSink: logs,
        logLevel: options.logLevel ?? "debug",
        emailTransport: email,
        providers: [{ provide: TRIGGER_CLIENT, useValue: trigger }, ...(options.providers ?? [])],
        imports: options.imports ?? [],
      }),
    ],
  });
  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.token).useValue(override.value);
  }
  let app: NestExpressApplication | undefined;
  try {
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
      bufferLogs: true,
    });
    configureApp(app);
    await initializeApp(app);
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const overridden = new Set((options.overrides ?? []).map((override) => override.token));
    if (
      (!overridden.has(CLOCK) && app.get(CLOCK, { strict: false }) !== clock) ||
      (!overridden.has(EMAIL_TRANSPORT) && app.get(EMAIL_TRANSPORT, { strict: false }) !== email)
    ) {
      throw new Error("The test app did not receive the injected clock and email transport");
    }
    return new TestApp({ app, config, clock, trigger, email, logs, dataDir, ownsDataDir, port });
  } catch (error) {
    await app?.close().catch(() => undefined);
    if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
