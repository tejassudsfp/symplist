import {
  DbError,
  type DbRow,
  type FetchLike,
  type LocalSqliteClient,
  type Statement,
  type StatementResult,
} from "@symplist/db";

/** A request the fake D1 API received. Tests count these to prove request budgets (§3.1). */
export interface RecordedD1Request {
  readonly url: string;
  readonly endpoint: "query" | "raw";
  readonly authorization: string | null;
  readonly body: { readonly batch?: readonly Statement[]; readonly sql?: string };
}

export type FakeD1Response = Response | "network_error" | Promise<Response | "network_error">;

export interface FakeD1ApiOptions {
  /** The database that executes requests, typically an in-memory local client. */
  readonly database: LocalSqliteClient;
  readonly accountId?: string;
  readonly databaseId?: string;
  readonly apiToken?: string;
  /** Requests allowed before the fake answers 429; advertised through `Ratelimit` headers. */
  readonly quota?: number;
  readonly windowSeconds?: number;
}

export const FAKE_D1_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const FAKE_D1_DATABASE_ID = "01234567-89ab-4cde-8f01-23456789abcd";
/** A throwaway credential for the fake only. */
export const FAKE_D1_API_TOKEN = "fake-d1-token-for-tests";

function envelope(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRaw(result: StatementResult): unknown {
  const columns = result.results[0] ? Object.keys(result.results[0]) : [];
  return {
    columns,
    rows: result.results.map((row: DbRow) => columns.map((column) => row[column] ?? null)),
  };
}

/**
 * A fake of the D1 REST API (`POST …/d1/database/{id}/query` and `/raw`) backed by `node:sqlite`.
 * It answers with the documented envelope, HTTP 400 for SQL failures, 401 for a wrong token,
 * `Ratelimit`/`Ratelimit-Policy` headers, and 429 with `Retry-After` once the quota is spent.
 */
export class FakeD1Api {
  readonly requests: RecordedD1Request[] = [];
  readonly fetch: FetchLike;
  private readonly options: Required<Omit<FakeD1ApiOptions, "database">> & {
    database: LocalSqliteClient;
  };
  private readonly intercepts: Array<(request: RecordedD1Request) => FakeD1Response | undefined> =
    [];

  constructor(options: FakeD1ApiOptions) {
    this.options = {
      database: options.database,
      accountId: options.accountId ?? FAKE_D1_ACCOUNT_ID,
      databaseId: options.databaseId ?? FAKE_D1_DATABASE_ID,
      apiToken: options.apiToken ?? FAKE_D1_API_TOKEN,
      quota: options.quota ?? 1200,
      windowSeconds: options.windowSeconds ?? 300,
    };
    this.fetch = (url, init) => this.handle(url, init);
  }

  /** Answers the next request with `respond` instead of executing it (after recording it). */
  interceptNext(respond: (request: RecordedD1Request) => FakeD1Response | undefined): void {
    this.intercepts.push(respond);
  }

  private rateLimitHeaders(): Record<string, string> {
    const remaining = Math.max(0, this.options.quota - this.requests.length);
    return {
      ratelimit: `"default";r=${remaining};t=${this.options.windowSeconds}`,
      "ratelimit-policy": `"default";q=${this.options.quota};w=${this.options.windowSeconds}`,
    };
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const parsed = new URL(url);
    const match = /\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/(query|raw)$/.exec(parsed.pathname);
    const headers = new Headers(init.headers);
    let body: unknown;
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = undefined;
    }
    const request: RecordedD1Request = {
      url,
      endpoint: match?.[3] === "raw" ? "raw" : "query",
      authorization: headers.get("authorization"),
      body: isRecord(body) ? (body as RecordedD1Request["body"]) : {},
    };
    this.requests.push(request);

    const intercept = this.intercepts.shift();
    const intercepted = intercept?.(request);
    if (intercepted !== undefined) {
      const response = await intercepted;
      if (response === "network_error") throw new TypeError("fetch failed");
      return response;
    }

    if (init.method !== "POST" || !match) {
      return envelope(404, {
        success: false,
        errors: [{ code: 7404, message: "Not found" }],
        messages: [],
        result: [],
      });
    }
    if (request.authorization !== `Bearer ${this.options.apiToken}`) {
      return envelope(401, {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
        messages: [],
        result: [],
      });
    }
    if (match[1] !== this.options.accountId || match[2] !== this.options.databaseId) {
      return envelope(404, {
        success: false,
        errors: [{ code: 7404, message: "Database not found" }],
        messages: [],
        result: [],
      });
    }
    if (this.requests.length > this.options.quota) {
      return envelope(
        429,
        {
          success: false,
          errors: [
            { code: 971, message: "Please wait and consider throttling your request speed" },
          ],
          messages: [],
          result: [],
        },
        { "retry-after": String(this.options.windowSeconds), ...this.rateLimitHeaders() },
      );
    }

    try {
      let results: readonly StatementResult[];
      if (Array.isArray(request.body.batch)) {
        results = await this.options.database.batch(request.body.batch);
      } else if (typeof request.body.sql === "string") {
        await this.options.database.executeScript(request.body.sql);
        results = [{ success: true, results: [], meta: {} }];
      } else {
        return envelope(400, {
          success: false,
          errors: [{ code: 7400, message: "Malformed request body" }],
          messages: [],
          result: [],
        });
      }
      return envelope(
        200,
        {
          success: true,
          errors: [],
          messages: [],
          result: results.map((result) => ({
            success: true,
            results: request.endpoint === "raw" ? toRaw(result) : result.results,
            meta: { ...result.meta, served_by_primary: true },
          })),
        },
        this.rateLimitHeaders(),
      );
    } catch (error) {
      const message =
        error instanceof DbError
          ? `${error.providerMessage ?? error.message}: SQLITE_ERROR`
          : "Internal error";
      return envelope(
        400,
        { success: false, errors: [{ code: 7500, message }], messages: [], result: [] },
        this.rateLimitHeaders(),
      );
    }
  }
}
