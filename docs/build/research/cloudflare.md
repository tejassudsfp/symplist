# Cloudflare research (verified 2026-09-15)

Scope: Cloudflare D1 used only through the Cloudflare REST API (from NestJS on Render and Trigger.dev tasks), Cloudflare R2 through the S3-compatible API with `@aws-sdk/client-s3`, D1 schema migrations, beta-relevant limits, and Node 24 `node:sqlite` as the local stand-in for D1.

How this was verified:
- Versions come from `npm view` on 2026-09-15.
- API facts come from the official Cloudflare, AWS, SQLite and Node.js docs linked below.
- Wrangler's remote migration behavior was read from the published `wrangler@4.131.2` tarball (`wrangler-dist/cli.js`).
- Local experiments ran on Node v24.15.0 in a throwaway scratch directory:
  - `node:sqlite` batch, CAS and limits behavior
  - S3 SDK request headers captured against a local mock server
  - TypeScript 7.0.2 typechecks with `skipLibCheck: false`
- Nothing was run against a live Cloudflare account. Every statement marked "verify live" still needs a test against a dev database or bucket.

## Versions

| package | version | peer/engine notes |
| --- | --- | --- |
| `@aws-sdk/client-s3` | 3.1132.0 | engines `node >=20.0.0`; no peers. Its own `devDependencies` pin `typescript ~7.0.2`. A TS 7.0.2 typecheck (skipLibCheck false) was clean. |
| `@aws-sdk/s3-request-presigner` | 3.1132.0 | engines `node >=20.0.0`; no peers. Only needed if presigned URLs are ever used (not recommended for bundles). |
| `cloudflare` (official TS SDK) | 7.1.0 | no engines, no peers, zero runtime deps. Built with TypeScript 5.8.3, but its `.d.ts` typecheck clean under TS 7.0.2. Retries 2 times by default. **Not recommended for D1 writes** (see Decisions). |
| `wrangler` | 4.131.2 | engines `node >=22.0.0`; optional peer `@cloudflare/workers-types ^5.20260911.1`. Depends on `workerd` 1.20260911.1 (a native binary that would need pnpm `allowBuilds`) and `miniflare`. Use it as an ops CLI via `pnpm dlx`, not as an app dependency. |
| `@cloudflare/workers-types` | 5.20260915.1 | Not needed: Symplist has no Workers code. |
| `typescript` | 7.0.2 | engines `node >=16.20.0` (dist-tag `latest`; `next` is 7.1.0-dev, not used). |
| `@types/node` | 24.13.4 (latest 24.x) | Types `node:sqlite` including `setAuthorizer`, `constants`, `isTransaction`, `columns()`, `sourceSQL`. **Does not type** the `limits` option/property (added in Node 24.15.0); TS 7 reports TS2353/TS2339 if you use it. |
| Node.js | 24.15.0 local; latest 24.x is 24.21.0 (2026-09-07, LTS "Krypton") | `node:sqlite` is "Stability: 1.2 - Release candidate" as of v24.15.0. It needs no flag and printed no warning (stderr was empty). |
| SQLite (local) | `sqlite_version()` = 3.53.4; `process.versions.sqlite` = 3.53.0 | Homebrew `node@24` appears to link a shared SQLite, so the runtime version can differ from the compiled header. |
| D1 REST / R2 S3 API | unversioned HTTP APIs | Base URL `https://api.cloudflare.com/client/v4`; R2 S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. |

## Verified APIs

### 1. D1 REST query endpoints

Sources:
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/raw/

- **Endpoints:**
  - `POST /accounts/{account_id}/d1/database/{database_id}/query` returns rows as objects.
  - `POST /accounts/{account_id}/d1/database/{database_id}/raw` returns "rows as arrays rather than objects. This is a performance-optimized version of the /query endpoint". Its `results` is `{ columns: string[], rows: unknown[][] }`.
- **Auth:** `Authorization: Bearer <token>`. The API reference lists accepted permissions `D1 Read` / `D1 Write`; the dashboard names them "D1 Read" / "D1 Edit" (https://developers.cloudflare.com/fundamentals/api/reference/permissions/). The 2025-05-02 release note says "`D1:Edit` permission is required for any database writes via HTTP API" (https://developers.cloudflare.com/d1/platform/release-notes/).
- **Body:** `{ sql, params? }` or `{ batch: [{ sql, params? }] }`. `params` is documented as "optional array of string", and the official `cloudflare` SDK types it as `Array<string>`. The `sql` description: "Your SQL query. Supports multiple statements, joined by semicolons, which will be executed as a batch."
- **Response (200 schema):** `{ success: true, errors: ResponseInfo[], messages: ResponseInfo[], result: QueryResult[] }`.
  - `ResponseInfo` is `{ code (>=1000), message, documentation_url?, source?: { pointer? } }`.
  - `QueryResult` is `{ success?, results?: unknown[], meta? }`, with one entry per statement.
- **`meta` fields and documented meanings:**
  - `changed_db`
  - `changes`: "Rough indication of how many rows were modified by the query, as provided by SQLite's `sqlite3_total_changes()`"
  - `duration`
  - `last_row_id`: rows with `INTEGER PRIMARY KEY`; not populated for `WITHOUT ROWID`
  - `rows_read`: "including indices"
  - `rows_written`: "including indices"
  - `served_by_colo`
  - `served_by_primary`
  - `served_by_region`: `WNAM|ENAM|WEUR|EEUR|APAC|OC`
  - `size_after`: bytes
  - `timings.sql_duration_ms`
- **HTTP status codes:** Invalid SQL returns HTTP 400 (since 2024-04-12). An overloaded database returns HTTP 429 (since 2024-06-17). Source: https://developers.cloudflare.com/d1/platform/release-notes/
- **Free tier:** Since 2026-09-01, Workers Free accounts that exceed daily row limits get errors from the REST API until 00:00 UTC (https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

Typed client shape that matches the documented schema (plain `fetch` on Node 24):

```ts
// Source: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
type D1Statement = { sql: string; params?: string[] };            // params: "optional array of string"
type D1QueryBody = D1Statement | { batch: D1Statement[] };
type D1Meta = {
  changed_db?: boolean; changes?: number; duration?: number; last_row_id?: number;
  rows_read?: number; rows_written?: number; served_by_colo?: string; served_by_primary?: boolean;
  served_by_region?: "WNAM" | "ENAM" | "WEUR" | "EEUR" | "APAC" | "OC"; size_after?: number;
  timings?: { sql_duration_ms?: number };
};
type D1QueryResult<Row> = { success?: boolean; results?: Row[]; meta?: D1Meta };
type CfInfo = { code: number; message: string; documentation_url?: string; source?: { pointer?: string } };
type D1Envelope<Row> = { success: boolean; errors: CfInfo[]; messages: CfInfo[]; result: D1QueryResult<Row>[] };

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body satisfies D1QueryBody),
    signal: AbortSignal.timeout(35_000), // API requests must resolve in 30 s (D1 limits page)
  },
);
```

### 2. D1 atomicity, batch and consistency facts (what the docs actually say)

- **REST multi-statement `sql`:** "Supports multiple statements, joined by semicolons, which will be executed as a batch." (API reference above). The same sentence is on each `batch[]` entry. The REST docs do not use the words "transaction" or "atomic".
- **Workers binding `batch()`:** "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence." The same page also says: "D1 operates in auto-commit. Our implementation guarantees that each statement in the list will execute and commit, sequentially, non-concurrently." (https://developers.cloudflare.com/d1/worker-api/d1-database/). The two sentences read inconsistently; the transactional one is the explicit guarantee.
- **Implicit transaction:** "Because D1 runs every query inside an implicit transaction, user queries cannot change this during a query or migration." (https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- **No explicit transactions:** Dump files must have `BEGIN TRANSACTION`/`COMMIT` removed; otherwise you get "cannot start a transaction within a transaction" (https://developers.cloudflare.com/d1/best-practices/import-export-data/). So there are no interactive, multi-request transactions. One HTTP request is the largest atomic unit.
- **Serial execution:** "Each individual D1 database is inherently single-threaded, and processes queries one at a time." (https://developers.cloudflare.com/d1/platform/limits/)
- **Wrangler relies on single-request atomicity for migrations:** The docs say "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied." (https://developers.cloudflare.com/workers/wrangler/commands/d1/ and https://developers.cloudflare.com/d1/wrangler-commands/). In `wrangler@4.131.2`, `migrations apply --remote` sends each migration as **one** `POST .../query` with `{ sql: <file contents> + "\nINSERT INTO \"d1_migrations\" (name) values ('<file>');" }`.
- **REST always hits the primary:** "Sessions API is only available via the D1 Worker Binding and not yet available via the REST API". Also: "To use read replication, you have to use the D1 Sessions API, otherwise all queries will continue to be executed only by the primary database." (https://developers.cloudflare.com/d1/best-practices/read-replication/ and https://developers.cloudflare.com/d1/worker-api/d1-database/). REST reads are therefore read-your-writes consistent; `meta.served_by_primary` lets you assert it.
- **Retries:** D1 automatically retries only read-only queries (`SELECT`, `EXPLAIN`, `WITH`), up to two more times. Writes are not retried, and the docs recommend app-level retries only for idempotent writes (https://developers.cloudflare.com/d1/observability/debug-d1/ and https://developers.cloudflare.com/d1/best-practices/retry-queries/).
- **RETURNING:** An official D1 tutorial uses `INSERT INTO notes (text) VALUES (?) RETURNING *` and reads `results[0]` (https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-retrieval-augmented-generation-ai/). That example goes through the binding; RETURNING is SQL-level, so it is expected to populate `result[i].results` over REST too (verify live).
- **`changes()` is allowed:** D1's SQL docs point to the workerd SQLite source for the allowed function list (https://developers.cloudflare.com/d1/sql-api/sql-statements/). On workerd `main` (last changed 2026-09-04), `ALLOWED_SQLITE_FUNCTIONS` includes `changes`, `total_changes`, `last_insert_rowid` and `iif` (https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++).
- **STRICT tables:** D1 recommends them "to avoid issues with mismatched types" (https://developers.cloudflare.com/d1/worker-api/).

### 3. Atomic conditional write over REST (pattern)

Goal: advance a task page to a new Git bundle only if nobody else advanced it first, and record history in the same atomic step.

```sql
-- Schema (STRICT so string params coerce losslessly or fail)
CREATE TABLE pages (
  task_id    TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  write_id   TEXT NOT NULL,          -- random UUID of the write that produced this generation
  bundle_key TEXT NOT NULL,          -- immutable R2 key of the encrypted bundle
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE page_versions (
  task_id    TEXT NOT NULL REFERENCES pages(task_id),
  generation INTEGER NOT NULL,
  write_id   TEXT NOT NULL,
  bundle_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, generation)
) STRICT;
```

```json
{
  "batch": [
    {
      "sql": "UPDATE pages SET generation = generation + 1, write_id = ?, bundle_key = ?, updated_at = ? WHERE task_id = ? AND generation = ? RETURNING generation",
      "params": ["9b1c…", "bundles/t_1/8-9b1c….bundle", "1789500000000", "t_1", "7"]
    },
    {
      "sql": "INSERT INTO page_versions (task_id, generation, write_id, bundle_key, created_at) SELECT task_id, generation, write_id, bundle_key, updated_at FROM pages WHERE task_id = ? AND write_id = ?",
      "params": ["t_1", "9b1c…"]
    }
  ]
}
```

Decision logic:
1. **Write the bundle to R2 first.** Use an immutable key and `IfNoneMatch: "*"`.
2. **Send the batch above.**
   - `result[0].results.length === 1` means **committed**; the row carries the new generation.
   - `result[0].results.length === 0` means a **conflict**. Statement 2 inserts nothing because `write_id` did not change to ours. Leave the R2 object for the orphan sweeper.
3. **Guard dependent statements with the unique `write_id`, not `changes()`.** `changes()` only reflects the most recent INSERT/UPDATE/DELETE, so a third statement would see statement 2's count. Checking `write_id` stays correct in any statement order.
4. **Decide from RETURNING rows, not `meta.changes`.** The docs call `changes` a "rough indication" sourced from `sqlite3_total_changes()`.
5. **Unknown outcome** (timeout, connection reset, 5xx, 429 after send): never blindly resend.
   - Read `SELECT generation, write_id FROM pages WHERE task_id = ?`.
   - If `write_id` is ours, the write committed.
   - Otherwise re-plan from the current generation. Resending the same batch is harmless because of the `generation = ?` guard, but it can report a false "conflict" if the first attempt committed. Always reconcile by `write_id`.

String params: SQLite applies NUMERIC affinity when a TEXT operand is compared with an INTEGER column (https://www.sqlite.org/datatype3.html). STRICT tables "coerce the data into the appropriate type using the usual affinity rules" or raise an error if that is not lossless (https://www.sqlite.org/stricttables.html). This was verified locally:
- `generation = '2'` matches.
- `'42'` stored in an INTEGER column reads back as a number.
- `'abc'` throws `cannot store TEXT value in INTEGER column`.
- `LIMIT '1'` works.

What is guaranteed:
- **By SQLite:** a single UPDATE with a WHERE guard is atomic, and D1 runs it inside an implicit transaction. The compare-and-set on `generation` is therefore safe even if multi-statement atomicity were not.
- **By D1:** execution is serialized per database (single-threaded), so no other request interleaves inside one request.
- **By the docs' wording:** statements in one request are "executed as a batch", batch is documented as a transaction that rolls back entirely on failure, and wrangler's migration rollback depends on this. **This is not stated explicitly for the REST endpoint. Verify live** before relying on statement 2 being rolled back if it fails.

What is not guaranteed:
- Exactly-once HTTP delivery, and automatic write retries (none).
- Any interactive, multi-request transaction.
- A usable `last_row_id` when `changes = 0` (it keeps the previous value; seen locally).
- Idempotency keys on the server side (the `write_id` column is the app's own).

### 4. Limits relevant to the beta

Sources:
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/fundamentals/api/reference/limits/
- https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/

| Limit | Value |
| --- | --- |
| **Cloudflare API rate limit (applies to D1 REST)** | "Client API per user/account token: 1200/5 minutes"; "Client API per IP: 200/second". "If you exceed this limit, all API calls for the next five minutes will be blocked, receiving a `HTTP 429`". Response headers: `Ratelimit`, `Ratelimit-Policy`, and `retry-after` on 429. |
| D1 docs on REST | "D1's built-in REST API is best suited for administrative use as the global Cloudflare API rate limit applies." |
| Database size | 10 GB (Workers Paid; cannot be increased) / 500 MB (Free) |
| Account storage | 1 TB Paid / 5 GB Free |
| Bound parameters per query | 100 |
| SQL statement length | 100,000 bytes (applies to each statement in a batch) |
| String / BLOB / row size | 2,000,000 bytes |
| Columns per table | 100 |
| Query duration | 30 s. "Requests to Cloudflare API must resolve in 30 seconds. Therefore, this duration limit also applies to the entire batch call." |
| Time Travel (PITR) | 30 days Paid / 7 days Free; always on (https://developers.cloudflare.com/d1/reference/time-travel/) |
| Free tier | 5M rows read/day, 100k rows written/day, hard-enforced since 2026-09-01 |
| Paid tier | 25B rows read/month and 50M rows written/month included; then $0.001 per million rows read and $1.00 per million rows written; 5 GB storage included, then $0.75/GB-month |
| Throughput | Single-threaded per database. About 1 ms queries allow about 1,000 qps. A full queue returns "D1 DB is overloaded" |

Retryable D1 error messages (https://developers.cloudflare.com/d1/observability/debug-d1/):
- "D1 DB reset because its code was updated."
- "Internal error while starting up D1 DB storage caused object to be reset."
- "Network connection lost."
- "Internal error in D1 DB storage caused object to be reset."
- "Cannot resolve D1 DB due to transient issue on remote node."

Non-retryable app-action errors include "Exceeded maximum DB size." and the two free-tier daily limit messages.

### 5. D1 migrations

`wrangler d1 migrations apply <DB> --remote` (https://developers.cloudflare.com/d1/reference/migrations/ and https://developers.cloudflare.com/workers/wrangler/commands/d1/):
- Needs a Wrangler config with a `d1_databases` entry (`database_name`, `database_id`, optional `migrations_dir`, `migrations_table`, and `migrations_pattern`, which is new in 2026-06). It also needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).
- Confirmation is skipped in CI, "but the backup will still be captured".
- `--remote` runs entirely over the REST `/query` endpoint.

Migrations table, exactly as created by `wrangler@4.131.2`:

```sql
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
-- applied list: SELECT * FROM "d1_migrations" ORDER BY id
-- each migration, ONE request: POST /query { "sql": "<file contents>\nINSERT INTO \"d1_migrations\" (name)\nvalues ('<name with ' doubled>');" }
```

A custom runner that sends the same requests stays compatible with `wrangler d1 migrations list --remote`. Because `name` is `UNIQUE`, a second concurrent runner's request fails on the INSERT, and (given batch atomicity) its DDL rolls back too. This was checked with the local adapter; verify live. For table rebuilds, put `PRAGMA defer_foreign_keys = on` at the start of the migration (https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

### 6. R2 through the S3 API with `@aws-sdk/client-s3`

Sources:
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/platform/limits/
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- https://developers.cloudflare.com/r2/api/tokens/

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";

export const r2 = new S3Client({
  region: "auto",                                              // "the region for an R2 bucket is `auto`"
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,   // EU jurisdiction: https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com
  credentials: { accessKeyId, secretAccessKey },
  // AWS names: https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html (default WHEN_SUPPORTED)
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

// Create-only write: R2 PutObject supports If-Match / If-None-Match / If-(Un)Modified-Since
try {
  await r2.send(new PutObjectCommand({
    Bucket, Key: `bundles/${taskId}/${generation}-${writeId}.bundle`,
    Body: encryptedBundle, ContentType: "application/octet-stream",
    IfNoneMatch: "*", Metadata: { "write-id": writeId },
  }));
} catch (err) {
  if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 412) {
    // Key already exists (possibly our own earlier attempt after an SDK retry): HeadObject and compare Metadata["write-id"].
  } else throw err;
}
```

- **Endpoint and region:** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Region is `auto`; "an empty value and `us-east-1` will alias to the `auto` region." Jurisdictional buckets are reachable only through their own endpoint (`.eu.` or `.fedramp.`).
- **Checksums (R2 table):**
  - `CRC64NVME`: FULL_OBJECT only.
  - `CRC32`, `CRC32C`, `SHA1`, `SHA256`: COMPOSITE only.
  - The AWS JS SDK default algorithm is CRC32 (AWS data-integrity page).
  - PutObject lists `Content-MD5` as supported.
- **SDK checksum behavior measured locally (3.1132.0, mock server):**
  - Default `PutObject` with a string body sends `x-amz-sdk-checksum-algorithm: CRC32` and `x-amz-checksum-crc32`.
  - Default `PutObject` with a stream body sends `content-encoding: aws-chunked`, `x-amz-content-sha256: STREAMING-UNSIGNED-PAYLOAD-TRAILER` and `x-amz-trailer: x-amz-checksum-crc32`.
  - Default `GetObject` sends `x-amz-checksum-mode: ENABLED`.
  - Default presigned PUT URLs embed `x-amz-checksum-crc32` (computed over the empty body at signing time) and `x-amz-sdk-checksum-algorithm`.
  - With both options set to `WHEN_REQUIRED`, all of these checksum headers and query params disappear.
  - `DeleteObjectsCommand` still sends CRC32 and no `Content-MD5` even with `WHEN_REQUIRED`. AWS documents an MD5 fallback middleware for third-party S3 services (https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/MD5_FALLBACK.md).
  - Cloudflare's aws-sdk-js-v3 page (updated 2026-04-21) sets neither option. Whether R2 accepts the defaults today is **not documented; verify live**.
- **Conditional put:** `IfNoneMatch: "*"` is sent as `If-None-Match: *`. A 412 response surfaces as `err.name === "PreconditionFailed"` with `$metadata.httpStatusCode === 412` (mock). AWS semantics: 412 if the key exists; `409 ConditionalRequestConflict` if a conflicting write races, in which case retry (https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html). R2 documents 412 `PreconditionFailed` for its conditional headers (https://developers.cloudflare.com/r2/api/s3/extensions/).
- **Consistency:** Strongly consistent globally for read-after-write, metadata updates, deletes and listings. "In the event two clients are writing (`PUT` or `DELETE`) to the same key, the last writer to complete 'wins'." The S3 API does not pass through the Cloudflare cache. API token permission changes are eventually consistent (up to about a minute).
- **Limits:**
  - Single-part upload up to 5 GiB.
  - Metadata 8,192 bytes.
  - Key 1,024 bytes.
  - **"Maximum concurrent writes to the same object name (key): 1 per second"**; more returns HTTP 429.
  - The R2 *Cloudflare REST API* is limited to 1,200 requests per 5 minutes, but the S3 API is the documented high-throughput path.
- **Presigned URLs:**
  - Generated locally with SigV4, valid from 1 second to 7 days.
  - Support `GET`, `HEAD`, `PUT` and `DELETE`; POST form uploads are not supported.
  - Work only on the `r2.cloudflarestorage.com` domain, not custom domains.
  - A signed `ContentType` is enforced (mismatch gives 403 `SignatureDoesNotMatch`).
  - "Treat presigned URLs as bearer tokens."
- **Tokens:** "Object Read & Write" scoped to specific buckets. These permissions work only with the S3-compatible API.
- **Local development:** "Currently, you cannot use AWS S3-compatible API while developing locally via `wrangler dev`."

### 7. Node 24 `node:sqlite` as the local D1 stand-in

Source: https://nodejs.org/docs/latest-v24.x/api/sqlite.html. Constructor options:
- `timeout`: busy timeout, default 0
- `enableForeignKeyConstraints`: default true, matching D1 enforcement
- `readBigInts`: default false
- `defensive`: default true since v24.14.0
- `limits`: works on 24.15.0 (tested); the docs don't give the version it was added

APIs used:
- `database.exec(sql)`: multiple statements, no results
- `database.prepare(sql)` returns a `StatementSync` with `all`, `get` and `run`. `run()` returns `{ changes, lastInsertRowid }`.
- `statement.columns()`, `statement.sourceSQL`
- `database.isTransaction` (v24.0.0)
- `database.setAuthorizer(cb)` (v24.10.0) with `constants.SQLITE_DENY` / `SQLITE_OK`
- `database.limits` (v24.15.0)

```ts
import { DatabaseSync, constants } from "node:sqlite";

const db = new DatabaseSync(".data/d1-local.sqlite", { timeout: 5000 });
db.exec("PRAGMA journal_mode = WAL");
let inUserSql = false;
db.setAuthorizer((action) =>
  inUserSql && [constants.SQLITE_TRANSACTION, constants.SQLITE_SAVEPOINT, constants.SQLITE_ATTACH].includes(action)
    ? constants.SQLITE_DENY : constants.SQLITE_OK); // mirror D1: no user BEGIN/COMMIT/SAVEPOINT

function batch(stmts: { sql: string; params?: string[] }[]) {
  db.exec("BEGIN IMMEDIATE");                        // exec() without BEGIN is NOT atomic (verified)
  try {
    inUserSql = true;
    const out = stmts.map(({ sql, params = [] }) => {
      const st = db.prepare(sql);
      // prepare() silently compiles only the FIRST statement (verified): reject multi-statement entries
      if (st.sourceSQL.trim().replace(/;\s*$/, "") !== sql.trim().replace(/;\s*$/, "")) throw new Error("one statement per entry");
      if (st.columns().length > 0) return { success: true, results: st.all(...params) };   // SELECT or ... RETURNING
      const r = st.run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    });
    inUserSql = false;
    db.exec("COMMIT");
    return out;
  } catch (e) { inUserSql = false; db.exec("ROLLBACK"); throw e; }
}
```

Experiment results (Node v24.15.0, no flags, empty stderr):
- **CAS pattern from §3:** first write returns `[{generation: 2}]` and inserts one version row. A stale retry returns `[]` with 0 changes.
- **Failing batch:** a UNIQUE violation in statement 2 rolled back statement 1.
- **`exec()` without BEGIN:** `exec("INSERT 5; INSERT 'bad'; INSERT 6")` left row 5 behind, so it is not atomic.
- **`prepare()` with two INSERTs:** executed only the first (`changes: 1`), silently.
- **Authorizer:** denied user `COMMIT`/`SAVEPOINT` with "not authorized". A nested BEGIN raises "cannot start a transaction within a transaction", the same text D1's docs mention.
- **`changes()` inside a transaction:** 0 after a no-op UPDATE and 1 after a one-row UPDATE (`total_changes()` is cumulative).
- **Two connections:** a second connection's `BEGIN IMMEDIATE` with `timeout: 0` got "database is locked".
- **Runtime limits** `{ variableNumber: 100, sqlLength: 100000, length: 2000000 }` rejected 101 params ("too many SQL variables") and a statement over 100 KB ("string or blob too big"). `@types/node` 24.13.4 does not type `limits`, so enforce these in the shared client instead.
- **Migration simulation:** the wrangler-shaped migration request run as `exec` inside BEGIN IMMEDIATE applied once. A racing re-apply failed on `UNIQUE constraint failed: d1_migrations.name` and its extra `CREATE TABLE` was rolled back.

### 8. TypeScript 7.0.2 compatibility evidence

A scratch project with `module`/`moduleResolution: nodenext`, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `skipLibCheck: false` typechecked clean with `tsc` 7.0.2 (Go-native, about 0.5 s). It covered:
- `@aws-sdk/client-s3` S3Client with checksum options, `IfNoneMatch`, `S3ServiceException`
- `@aws-sdk/s3-request-presigner` `getSignedUrl`
- `cloudflare` `d1.database.query`
- `node:sqlite` (`setAuthorizer`, `constants`, `SQLInputValue`, `isTransaction`)

Deliberate errors were reported correctly: `requestChecksumCalculation: "NEVER"`, a numeric `IfNoneMatch`, and numeric D1 `params`. So the check is real, not vacuous. `@aws-sdk/client-s3` itself is developed against `typescript ~7.0.2`. Wrangler is a CLI with no TypeScript consumer surface.

## Decisions and recommendations

1. **D1 client**
   - Write a small typed `fetch` client (shape in §1) in a shared workspace package, used by both NestJS and the Trigger.dev worker.
   - Do not use the `cloudflare` SDK for D1. It retries 408/409/429/5xx and connection errors 2 times by default (its README and `client.js`), which can silently re-run non-idempotent writes, and it adds nothing over the documented JSON.
   - Use `/query` by default and `/raw` only for large read-only result sets.
2. **Request shapes**
   - App code uses `{ batch: [...] }` with exactly one statement per entry and positional `?` params.
   - Multi-statement `{ sql }` is reserved for migrations (no params).
   - Never interpolate user data into SQL.
3. **Every logical write is one request.** There are no cross-request transactions. Read-modify-write needs a version guard (`generation`) plus a unique `write_id`. Decide success from `RETURNING` rows, never from `meta.changes` or `last_row_id` (§3).
4. **No transport-level write retries.** On an unknown outcome, reconcile by reading `write_id`, then retry at the app or Trigger.dev level. Reads may retry with backoff and jitter on the retryable D1 messages in §4.
5. **Rate-limit budget (mandatory)**
   - Put a shared token bucket in the client, budgeted below 1,200 requests per 5 minutes per token (for example about 1,000 per 5 minutes, spread over the window).
   - Honor `retry-after` and the `Ratelimit` headers.
   - Emit metrics for 429s and remaining quota.
   - Batch reads (one request, several SELECTs), cache hot reads in the backend process, and keep chat and WebSocket fan-out off D1 where possible.
   - Use separate D1-only tokens for Render and Trigger, account-owned if possible, and measure whether their budgets are independent.
6. **Params:** encode every param as a string (numbers `String(n)`, booleans `"1"`/`"0"`) to match the documented `array of string`. Use STRICT tables. Write `NULL` literally in SQL rather than binding null until JSON null/number params are verified live. Enforce D1 limits in the client before sending: at most 100 params and 100 KB per statement, 2 MB per value, and a 35 s abort.
7. **Migrations:** add a custom REST runner that reproduces wrangler's `d1_migrations` table and one-request-per-migration shape (§5).
   - Run it once as the Render pre-deploy step, with expand/contract-only migrations (per the project's deploy decision).
   - Run the same runner against the local SQLite adapter.
   - Keep `wrangler` out of app dependencies (native `workerd` binary). Use `pnpm dlx wrangler@4.131.2 d1 migrations list --remote` and Time Travel restores as manual ops tools.
8. **D1 setup:** production on Workers Paid (10 GB, no daily hard cap, 30-day Time Travel). Separate dev and prod databases. Create each with a location hint near the Render region (`wnam`/`enam`/`weur`/…) (https://developers.cloudflare.com/d1/configuration/data-location/).
9. **R2 client:**
   - Configure `@aws-sdk/client-s3` 3.1132.0 with `region: "auto"`, the account endpoint, and both checksum options set to `"WHEN_REQUIRED"`. Integrity comes from the app's authenticated encryption of bundles.
   - Use immutable keys (`bundles/{taskId}/{generation}-{writeId}.bundle`) with `IfNoneMatch: "*"`. This avoids last-writer-wins and the 1 write/s per key limit.
   - Treat 412 as "exists, verify `write-id` metadata".
   - Order writes as R2 first, D1 CAS second. A scheduled Trigger.dev sweeper deletes unreferenced objects older than a grace period, one `DeleteObject` per key (avoid `DeleteObjects` unless verified live).
10. **R2 access:** use a bucket-scoped "Object Read & Write" token, private buckets, no `r2.dev` or public access, and no presigned URLs for bundles. If attachments later need browser upload, sign with the `WHEN_REQUIRED` client, short expiries and a signed `ContentType`.
11. **Local adapters** (decision A7):
    - The D1 stand-in is `node:sqlite` implementing the §7 semantics: `BEGIN IMMEDIATE` per request, a one-statement guard via `sourceSQL`, an authorizer denying BEGIN/COMMIT/SAVEPOINT/ATTACH, WAL, `timeout: 5000`, and the same response envelope.
    - The R2 stand-in writes files with `fs.open(path, "wx")`, which "fails if the path exists" (https://nodejs.org/docs/latest-v24.x/api/fs.html), to emulate `If-None-Match: *`.
    - Both refuse to start when `NODE_ENV=production`.
12. **Contract tests:** one suite runs against the local adapters and, behind an env flag, against the dev D1 database and R2 bucket. Cover batch rollback on a failing second statement, CAS conflict, RETURNING rows, string-param coercion, JSON number/null params, rate-limit headers, R2 412 on `IfNoneMatch`, and R2 acceptance of SDK defaults vs `WHEN_REQUIRED`.
13. **Tooling:** TypeScript 7.0.2 works for everything in this topic; no TS 6/5 fallback is needed. Use `@types/node` 24.13.4 and avoid relying on untyped `node:sqlite` `limits`. Consider moving local Node from 24.15.0 to 24.21.0 (latest 24.x); note that `prepare()` of SQL with no statements throws `ERR_INVALID_ARG_VALUE` from v24.21.0.

## Risks and open questions

- **R1: REST rate limit (highest risk).** D1 over REST shares the Cloudflare API limit: 1,200 requests per 5 minutes per user/account token, and a breach **blocks all API calls for 5 minutes**. Cloudflare says the REST API "is best suited for administrative use". A chatty chat or agent workload can exceed about 4 req/s. The only documented mitigation is a Worker proxy, which the "REST only" constraint rules out. Open questions: are account-owned tokens budgeted independently? Can the limit be raised (docs say Enterprise only)?
- **R2: REST batch atomicity is implied, not stated.** The binding docs guarantee it; the REST docs say "executed as a batch"; wrangler's migration rollback depends on it. The binding page also contains a contradictory "execute and commit" sentence. Verify live with a failing second statement.
- **R3: Param types.** The documented `params` type is `array of string`. JSON numbers, booleans and null are unverified. Affinity coercion works for comparisons and STRICT columns, but typeless expressions (for example `? + 1`, or `json_extract` comparisons) may behave differently with text.
- **R4: `meta.changes`** is described as "rough" and as `sqlite3_total_changes()`. It is unsuitable for correctness decisions; RETURNING-based decisions depend on RETURNING working over REST (expected, verify).
- **R5: Unknown-outcome writes.** Timeouts can hide commits. Every write path needs `write_id` reconciliation, and Trigger.dev retries must not replay stale CAS inputs.
- **R6: Latency.** Every query is an HTTPS round trip from Render to Cloudflare to the D1 primary, with no pooling or streaming. Measure p50/p95 from the Render region during risk tests.
- **R7: Capacity.** 10 GB hard cap per database, single-threaded throughput, and an overloaded database returns 429. Chat history growth needs retention or archival (for example old messages to R2) before the cap matters.
- **R8: Free-tier enforcement since 2026-09-01.** A dev database on a Free account will hard-fail after 100k written rows per day.
- **R9: R2 checksums.** Cloudflare's current docs no longer mention SDK checksum settings. Live behavior for CRC32 headers, aws-chunked trailers and `DeleteObjects` without `Content-MD5` is unverified; the `WHEN_REQUIRED` config avoids most of it.
- **R10: R2 per-key write rate** of 1/s (429 above it) and last-writer-wins. Mitigated by immutable keys; any mutable "pointer" object must be avoided (keep pointers in D1).
- **R11: Orphaned R2 objects** from lost CAS races or crashes between the R2 put and the D1 commit. They cost storage only, but need the sweeper, and its grace period must exceed the maximum write duration.
- **R12: Local vs D1 drift.** `node:sqlite` has no D1 function allowlist or PRAGMA restrictions. Its SQLite version (3.53.x, Homebrew-linked) may differ from D1's, and the stability is "Release candidate". Contract tests against a real dev database are the backstop.
- **R13: Migrations via a custom runner** must match wrangler's request shape exactly to stay compatible with `wrangler d1 migrations list`. A migration file over 100 KB per statement, or taking over 30 s, will fail and must be split. `wrangler d1 execute --file` uses a separate import API that this runner does not use.
- **Q1:** Does a D1 REST error inside a batch return HTTP 400 with an empty `result`, or 200 with per-statement `success: false`? Treat both as failure until observed.
- **Q2:** Are `D1 Write`/`D1 Edit` token permissions scoped per database, or only account-wide? Decide the token layout for dev and prod accordingly.
