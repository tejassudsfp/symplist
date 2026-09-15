import type { Statement } from "./client.ts";
import { DbInvalidStatementError } from "./errors.ts";
import { tokenizeSql } from "./sql-lexer.ts";

/**
 * A named parameter value. Strings are bound as-is. `null` and `undefined` become SQL `NULL`
 * literals in the compiled text, never bound nulls (§3.2). A string array expands to a
 * comma-separated placeholder list for `IN (:ids)`; an empty array becomes `NULL`, so `IN (NULL)`
 * matches nothing.
 */
export type SqlParam = string | null | undefined | readonly string[];

export type SqlParams = Readonly<Record<string, SqlParam>>;

const parameterName = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalid(detail: string): DbInvalidStatementError {
  return new DbInvalidStatementError("db.invalid_statement", detail);
}

/**
 * Compiles SQL written with named parameters (`:user`) into a statement with positional `?`
 * parameters. Every `:name` in the text must be supplied and every supplied name must be used.
 * Names inside string literals, quoted identifiers and comments are ignored.
 *
 * ```ts
 * sql("UPDATE tasks SET title_enc = :title, write_id = :w WHERE id = :id AND archived_at = :at", {
 *   title, w: writeId, id, at: null, // becomes `archived_at = NULL`
 * });
 * ```
 */
export function sql(text: string, params: SqlParams = {}): Statement {
  if (typeof text !== "string") throw invalid("SQL text must be a string");
  for (const name of Object.keys(params)) {
    if (!parameterName.test(name)) throw invalid(`Invalid parameter name ${JSON.stringify(name)}`);
  }

  const used = new Set<string>();
  const bound: string[] = [];
  let compiled = "";
  let cursor = 0;

  for (const token of tokenizeSql(text)) {
    if (token.kind !== "parameter") continue;
    if (!token.text.startsWith(":")) {
      throw invalid(`Use :name parameters; found ${token.text.charAt(0)} placeholder`);
    }
    const name = token.text.slice(1);
    if (!Object.hasOwn(params, name)) throw invalid(`Missing value for parameter :${name}`);
    used.add(name);
    const value = params[name];
    let replacement: string;
    if (value === null || value === undefined) {
      replacement = "NULL";
    } else if (typeof value === "string") {
      bound.push(value);
      replacement = "?";
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        replacement = "NULL";
      } else {
        for (const item of value) {
          if (typeof item !== "string") throw invalid(`Parameter :${name} must contain strings`);
          bound.push(item);
        }
        replacement = value.map(() => "?").join(", ");
      }
    } else {
      throw invalid(
        `Parameter :${name} must be a string, string array, null or undefined; encode numbers with int() and booleans with bool()`,
      );
    }
    compiled += text.slice(cursor, token.start) + replacement;
    cursor = token.end;
  }
  compiled += text.slice(cursor);

  for (const name of Object.keys(params)) {
    if (!used.has(name)) throw invalid(`Parameter :${name} is not used by the statement`);
  }
  return { sql: compiled, params: bound };
}

/** Encodes a safe integer (or bigint) as a string parameter. */
export function int(value: number | bigint): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalid("int() requires a safe integer");
  }
  // Normalize -0 so the text is a plain integer literal.
  return String(value === 0 ? 0 : value);
}

/** Encodes a boolean as `'1'` or `'0'`. */
export function bool(value: boolean): "1" | "0" {
  if (typeof value !== "boolean") throw invalid("bool() requires a boolean");
  return value ? "1" : "0";
}

/** Encodes a JSON value as a string parameter. */
export function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw invalid("json() requires a JSON-serializable value");
  return encoded;
}

const identifier = /^[a-z_][a-z0-9_]*$/;

/**
 * Asserts a table or column name is a plain lower-case identifier, for helpers that interpolate
 * names into SQL. Values always travel as parameters.
 */
export function assertIdentifier(name: string): string {
  if (typeof name !== "string" || !identifier.test(name)) {
    throw invalid(`Invalid SQL identifier ${JSON.stringify(name)}`);
  }
  return name;
}
