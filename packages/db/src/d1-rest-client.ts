import { type D1CircuitBreaker, processCircuitBreaker } from "./circuit-breaker.ts";
import type {
  BatchOptions,
  DbRow,
  MigrationTarget,
  Statement,
  StatementMeta,
  StatementResult,
} from "./client.ts";
import { D1Counters, type D1Outcome, type D1Runtime } from "./counters.ts";
import {
  DbError,
  DbInvalidStatementError,
  DbRateLimitedError,
  DbStatementError,
  DbUnavailableError,
  DbUnknownOutcomeError,
  isDbError,
  type UnknownOutcomeCause,
} from "./errors.ts";
import { APPEND_ONLY_TABLES, checkBatch, checkScript, D1_LIMITS } from "./limits.ts";
import {
  abortedError,
  type Clock,
  type LaneKind,
  processLane,
  type RateLane,
  systemClock,
} from "./rate-limit.ts";

/** The subset of `fetch` the client uses, injectable for tests and the fake D1 API. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

/**
 * D1 messages that mean a transient failure; reads retry on them, writes report an unknown outcome
 * (https://developers.cloudflare.com/d1/observability/debug-d1/).
 */
export const RETRYABLE_D1_MESSAGES: readonly string[] = Object.freeze([
  "D1 DB reset because its code was updated.",
  "Internal error while starting up D1 DB storage caused object to be reset.",
  "Network connection lost.",
  "Internal error in D1 DB storage caused object to be reset.",
  "Cannot resolve D1 DB due to transient issue on remote node.",
]);

export interface ReadRetryOptions {
  /** Total attempts for a read-only batch, including the first. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Base backoff delay; each retry doubles it before full jitter. Defaults to 200 ms. */
  readonly baseDelayMs?: number;
  /** Backoff cap. Defaults to 2 seconds. */
  readonly maxDelayMs?: number;
}

export interface D1RestClientOptions {
  readonly accountId: string;
  readonly databaseId: string;
  /** The lane's token: `CLOUDFLARE_D1_API_TOKEN`, `CLOUDFLARE_D1_WORKER_API_TOKEN` or the migrate token. */
  readonly apiToken: string;
  /** A lane kind selects the process-wide lane of that kind; pass a `RateLane` to own the bucket. */
  readonly lane: LaneKind | RateLane;
  /** Counter label; defaults to the lane kind or `api`. */
  readonly runtime?: D1Runtime;
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  /** Defaults to the process-wide circuit. */
  readonly circuit?: D1CircuitBreaker;
  readonly counters?: D1Counters;
  readonly clock?: Clock;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
  /** Defaults to 35 seconds (§3.2). */
  readonly timeoutMs?: number;
  readonly readRetry?: ReadRetryOptions;
  readonly appendOnlyTables?: readonly string[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

class TransportFailure extends Error {
  readonly failure: UnknownOutcomeCause;
  constructor(failure: UnknownOutcomeCause) {
    super(`D1 transport ${failure}`);
    this.failure = failure;
  }
}

type Parsed =
  | { readonly kind: "ok"; readonly results: StatementResult[] }
  | { readonly kind: "failed"; readonly error: DbStatementError; readonly retryable: boolean }
  | { readonly kind: "bad_response" };

const accountIdPattern = /^[0-9a-f]{32}$/i;
const databaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableMessage(message: string): boolean {
  return RETRYABLE_D1_MESSAGES.some((retryable) => message.includes(retryable));
}

function pickMeta(value: unknown): StatementMeta {
  if (!isRecord(value)) return {};
  const meta: Record<string, number> = {};
  for (const key of ["changes", "last_row_id", "duration", "rows_read", "rows_written"] as const) {
    const field = value[key];
    if (typeof field === "number" && Number.isFinite(field)) meta[key] = field;
  }
  return meta;
}

function collectMessages(body: Record<string, unknown>): string {
  const texts: string[] = [];
  for (const key of ["errors", "messages"] as const) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const info of list) {
      if (isRecord(info) && typeof info.message === "string") texts.push(info.message);
    }
  }
  return texts.join("; ");
}

function rowsFromRaw(value: unknown): DbRow[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows))
    return undefined;
  const columns = value.columns;
  if (!columns.every((column): column is string => typeof column === "string")) return undefined;
  const rows: DbRow[] = [];
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return undefined;
    rows.push(
      Object.fromEntries(columns.map((column, index) => [column, row[index] as DbRow[string]])),
    );
  }
  return rows;
}

/** Parses the D1 envelope. HTTP 400 or `success: false` at any level fails the whole batch (§3.2). */
function parseEnvelope(
  status: number,
  text: string,
  expected: number | undefined,
  raw: boolean,
): Parsed {
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    return { kind: "bad_response" };
  }
  if (!isRecord(body)) return { kind: "bad_response" };
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const resultList = Array.isArray(body.result) ? body.result : undefined;
  const failedIndex = resultList?.findIndex((entry) => isRecord(entry) && entry.success === false);

  if (status === 400 || body.success !== true || errors.length > 0 || (failedIndex ?? -1) >= 0) {
    const message = collectMessages(body) || "D1 reported a failed batch";
    return {
      kind: "failed",
      retryable: isRetryableMessage(message),
      error: new DbStatementError({
        providerMessage: message,
        statementIndex: failedIndex !== undefined && failedIndex >= 0 ? failedIndex : undefined,
        httpStatus: status,
      }),
    };
  }
  if (!resultList || (expected !== undefined && resultList.length !== expected)) {
    return { kind: "bad_response" };
  }
  const results: StatementResult[] = [];
  for (const entry of resultList) {
    if (!isRecord(entry)) return { kind: "bad_response" };
    let rows: DbRow[] | undefined;
    if (raw) {
      rows = rowsFromRaw(entry.results);
    } else if (entry.results === undefined) {
      rows = [];
    } else if (Array.isArray(entry.results) && entry.results.every(isRecord)) {
      rows = entry.results as DbRow[];
    }
    if (!rows) return { kind: "bad_response" };
    results.push({ success: true, results: rows, meta: pickMeta(entry.meta) });
  }
  return { kind: "ok", results };
}

/**
 * D1 over the Cloudflare REST API (§3.1, §3.2): every call is one request on a rate lane, fails fast
 * while the process-wide circuit is open, retries only read-only batches, and never retries a write.
 */
export class D1RestClient implements MigrationTarget {
  readonly counters: D1Counters;
  readonly lane: RateLane;
  private readonly url: string;
  private readonly rawUrl: string;
  private readonly authorization: string;
  private readonly fetchImpl: FetchLike;
  private readonly circuit: D1CircuitBreaker;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxReadAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly appendOnlyTables: readonly string[];

  constructor(options: D1RestClientOptions) {
    if (!accountIdPattern.test(options.accountId)) {
      throw new DbError("db.config_invalid", "CLOUDFLARE_ACCOUNT_ID must be a 32-character hex id");
    }
    if (!databaseIdPattern.test(options.databaseId)) {
      throw new DbError("db.config_invalid", "D1_DATABASE_ID must be a UUID");
    }
    if (typeof options.apiToken !== "string" || !/^[\x21-\x7e]+$/.test(options.apiToken)) {
      throw new DbError(
        "db.config_invalid",
        "The D1 API token must be a non-empty printable string",
      );
    }
    const baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE_URL).replace(/\/+$/, "");
    const parsedBase = new URL(baseUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsedBase.hostname);
    if (parsedBase.protocol !== "https:" && !(loopback && parsedBase.protocol === "http:")) {
      throw new DbError("db.config_invalid", "The D1 API base URL must use https");
    }
    const databasePath = `${baseUrl}/accounts/${options.accountId}/d1/database/${options.databaseId}`;
    this.url = `${databasePath}/query`;
    this.rawUrl = `${databasePath}/raw`;
    this.authorization = `Bearer ${options.apiToken}`;
    this.lane = typeof options.lane === "string" ? processLane(options.lane) : options.lane;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.circuit = options.circuit ?? processCircuitBreaker;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? D1_LIMITS.requestTimeoutMs;
    this.maxReadAttempts = Math.max(1, options.readRetry?.maxAttempts ?? 3);
    this.baseDelayMs = options.readRetry?.baseDelayMs ?? 200;
    this.maxDelayMs = options.readRetry?.maxDelayMs ?? 2_000;
    this.appendOnlyTables = options.appendOnlyTables ?? APPEND_ONLY_TABLES;
    const runtime: D1Runtime =
      options.runtime ?? (typeof options.lane === "string" ? options.lane : "api");
    this.counters =
      options.counters ??
      new D1Counters({ runtime, lane: this.lane.name, clock: this.clock, circuit: this.circuit });
  }

  async batch(
    statements: readonly Statement[],
    options: BatchOptions = {},
  ): Promise<readonly StatementResult[]> {
    let readOnly: boolean;
    try {
      readOnly = checkBatch(statements, this.appendOnlyTables).readOnly;
      if (options.raw && !readOnly) {
        throw new DbInvalidStatementError(
          "db.invalid_statement",
          "The /raw endpoint is for read-only batches",
        );
      }
    } catch (error) {
      this.counters.recordOutcome("invalid");
      throw error;
    }
    const body = {
      batch: statements.map((statement) => ({ sql: statement.sql, params: [...statement.params] })),
    };
    return this.execute({
      body,
      readOnly,
      expected: statements.length,
      raw: options.raw === true,
      options,
    });
  }

  async all<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<readonly Row[]> {
    const [result] = await this.batch([statement], options);
    return (result?.results ?? []) as readonly Row[];
  }

  async first<Row extends DbRow = DbRow>(
    statement: Statement,
    options?: BatchOptions,
  ): Promise<Row | null> {
    const rows = await this.all<Row>(statement, options);
    return rows[0] ?? null;
  }

  async run(statement: Statement, options?: BatchOptions): Promise<StatementResult> {
    const [result] = await this.batch([statement], options);
    if (!result) throw new DbUnknownOutcomeError("bad_response");
    return result;
  }

  /** Sends a multi-statement script as one `{ sql }` request. Reserved for migrations (§3.4). */
  async executeScript(sql: string, options: Pick<BatchOptions, "signal"> = {}): Promise<void> {
    try {
      checkScript(sql);
    } catch (error) {
      this.counters.recordOutcome("invalid");
      throw error;
    }
    await this.execute({
      body: { sql },
      readOnly: false,
      expected: undefined,
      raw: false,
      options,
    });
  }

  private async execute(input: {
    readonly body: unknown;
    readonly readOnly: boolean;
    readonly expected: number | undefined;
    readonly raw: boolean;
    readonly options: BatchOptions;
  }): Promise<StatementResult[]> {
    const { readOnly, options } = input;
    const maxAttempts = readOnly ? this.maxReadAttempts : 1;
    const payload = JSON.stringify(input.body);

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = readOnly && attempt < maxAttempts;
      const outcome = (value: D1Outcome) => this.counters.recordOutcome(value);

      try {
        this.circuit.assertClosed();
        const grant = await this.lane.acquire(options.priority ?? "authenticated", options.signal);
        this.counters.recordBucketWait(grant.waitedMs);
        this.circuit.assertClosed();
      } catch (error) {
        if (error instanceof DbRateLimitedError) outcome(error.reason);
        else if (isDbError(error, "db.aborted")) outcome("aborted");
        throw error;
      }

      let response: Response;
      let text: string;
      try {
        ({ response, text } = await this.send(
          input.raw ? this.rawUrl : this.url,
          payload,
          options.signal,
        ));
      } catch (error) {
        const failure = error instanceof TransportFailure ? error.failure : "network";
        if (failure === "network" && canRetry) {
          await this.backoff(attempt, options.signal);
          continue;
        }
        if (readOnly) {
          if (failure === "aborted") {
            outcome("aborted");
            throw abortedError();
          }
          outcome("unavailable");
          throw new DbUnavailableError(failure);
        }
        outcome("unknown_outcome");
        throw new DbUnknownOutcomeError(failure);
      }

      for (const policy of this.circuit.observeHeaders(response.headers)) {
        if (policy.remaining !== undefined) this.counters.recordRemaining(policy.remaining);
      }

      if (response.status === 429) {
        const retryAfterMs = this.circuit.recordTooManyRequests(response.headers);
        outcome("http_429");
        throw new DbRateLimitedError("http_429", retryAfterMs);
      }
      if (response.status === 401 || response.status === 403) {
        outcome("unauthorized");
        throw new DbError("db.unauthorized", `D1 rejected the API token (HTTP ${response.status})`);
      }

      if (response.status === 200 || response.status === 400) {
        const parsed = parseEnvelope(response.status, text, input.expected, input.raw);
        if (parsed.kind === "ok") {
          outcome("ok");
          return parsed.results;
        }
        if (parsed.kind === "failed") {
          if (!parsed.retryable) {
            outcome("statement_failed");
            throw parsed.error;
          }
          if (canRetry) {
            await this.backoff(attempt, options.signal);
            continue;
          }
          if (readOnly) {
            outcome("unavailable");
            throw new DbUnavailableError("server_error", parsed.error.providerMessage);
          }
          outcome("unknown_outcome");
          throw new DbUnknownOutcomeError("server_error", parsed.error.providerMessage);
        }
        if (canRetry) {
          await this.backoff(attempt, options.signal);
          continue;
        }
        if (readOnly) {
          outcome("unavailable");
          throw new DbUnavailableError("bad_response");
        }
        outcome("unknown_outcome");
        throw new DbUnknownOutcomeError("bad_response");
      }

      if (response.status >= 500) {
        if (canRetry) {
          await this.backoff(attempt, options.signal);
          continue;
        }
        if (readOnly) {
          outcome("unavailable");
          throw new DbUnavailableError("server_error");
        }
        outcome("unknown_outcome");
        throw new DbUnknownOutcomeError("server_error");
      }

      outcome("rejected");
      throw new DbError("db.request_rejected", `D1 rejected the request (HTTP ${response.status})`);
    }
  }

  private async send(
    url: string,
    payload: string,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; text: string }> {
    if (signal?.aborted) throw new TransportFailure("aborted");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.counters.recordSent();
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: this.authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    } catch {
      throw new TransportFailure(timedOut ? "timeout" : signal?.aborted ? "aborted" : "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async backoff(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    this.counters.recordRetry();
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    try {
      await this.clock.sleep(Math.floor(this.random() * ceiling), signal);
    } catch (error) {
      this.counters.recordOutcome("aborted");
      throw error;
    }
  }
}

export function createD1RestClient(options: D1RestClientOptions): D1RestClient {
  return new D1RestClient(options);
}
