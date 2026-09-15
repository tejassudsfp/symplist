import { DbInvalidStatementError } from "./errors.ts";

/**
 * A small SQLite lexer. It is not a parser: it only needs to find parameters, statement boundaries
 * and the handful of keywords that the clients inspect (write targets, transaction control and
 * read-only statements). String literals, quoted identifiers and comments never produce keywords,
 * parameters or statement boundaries.
 */
export type SqlTokenKind =
  | "word"
  | "identifier"
  | "string"
  | "blob"
  | "number"
  | "parameter"
  | "semicolon"
  | "punctuation";

export interface SqlToken {
  readonly kind: SqlTokenKind;
  /** Source text of the token. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Upper-cased text for `word` tokens; the unquoted name for `identifier` tokens. */
  readonly value: string;
}

const identifierStart = /[A-Za-z_\u0080-\uffff]/;
const identifierPart = /[A-Za-z0-9_$\u0080-\uffff]/;
const digit = /[0-9]/;

function invalid(detail: string): DbInvalidStatementError {
  return new DbInvalidStatementError("db.invalid_statement", detail);
}

/** Splits SQL into tokens, dropping whitespace and comments. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const length = sql.length;
  let index = 0;
  const push = (kind: SqlTokenKind, start: number, end: number, value?: string) => {
    const text = sql.slice(start, end);
    tokens.push({ kind, text, start, end, value: value ?? text });
  };

  while (index < length) {
    const char = sql.charAt(index);
    const next = sql.charAt(index + 1);

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      // SQLite treats an unterminated block comment as running to the end of input.
      index = close === -1 ? length : close + 2;
      continue;
    }
    if (char === "'") {
      const end = scanQuoted(sql, index, "'");
      if (end === -1) throw invalid("Unterminated string literal");
      push("string", index, end, sql.slice(index + 1, end - 1).replaceAll("''", "'"));
      index = end;
      continue;
    }
    if ((char === "x" || char === "X") && next === "'") {
      const end = scanQuoted(sql, index + 1, "'");
      if (end === -1) throw invalid("Unterminated blob literal");
      push("blob", index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === "`") {
      const end = scanQuoted(sql, index, char);
      if (end === -1) throw invalid("Unterminated quoted identifier");
      push("identifier", index, end, sql.slice(index + 1, end - 1).replaceAll(char + char, char));
      index = end;
      continue;
    }
    if (char === "[") {
      const close = sql.indexOf("]", index + 1);
      if (close === -1) throw invalid("Unterminated quoted identifier");
      push("identifier", index, close + 1, sql.slice(index + 1, close));
      index = close + 1;
      continue;
    }
    if (digit.test(char) || (char === "." && digit.test(next))) {
      let end = index;
      if (char === "0" && (next === "x" || next === "X")) {
        end += 2;
        while (end < length && /[0-9A-Fa-f_]/.test(sql.charAt(end))) end += 1;
      } else {
        while (end < length && /[0-9_]/.test(sql.charAt(end))) end += 1;
        if (sql.charAt(end) === ".") {
          end += 1;
          while (end < length && /[0-9_]/.test(sql.charAt(end))) end += 1;
        }
        if (/[eE]/.test(sql.charAt(end)) && /[0-9+-]/.test(sql.charAt(end + 1))) {
          end += 2;
          while (end < length && digit.test(sql.charAt(end))) end += 1;
        }
      }
      push("number", index, end);
      index = end;
      continue;
    }
    if (char === "?") {
      let end = index + 1;
      while (end < length && digit.test(sql.charAt(end))) end += 1;
      push("parameter", index, end);
      index = end;
      continue;
    }
    if ((char === ":" || char === "@" || char === "$") && identifierStart.test(next)) {
      let end = index + 2;
      while (end < length && identifierPart.test(sql.charAt(end))) end += 1;
      push("parameter", index, end);
      index = end;
      continue;
    }
    if (identifierStart.test(char)) {
      let end = index + 1;
      while (end < length && identifierPart.test(sql.charAt(end))) end += 1;
      push("word", index, end, sql.slice(index, end).toUpperCase());
      index = end;
      continue;
    }
    if (char === ";") {
      push("semicolon", index, index + 1);
      index += 1;
      continue;
    }
    push("punctuation", index, index + 1);
    index += 1;
  }
  return tokens;
}

/** Index just past the closing quote, honoring doubled quotes, or -1 when unterminated. */
function scanQuoted(sql: string, openIndex: number, quote: string): number {
  let index = openIndex + 1;
  while (index < sql.length) {
    const close = sql.indexOf(quote, index);
    if (close === -1) return -1;
    if (sql.charAt(close + 1) === quote) {
      index = close + 2;
      continue;
    }
    return close + 1;
  }
  return -1;
}

export interface SqlStatementText {
  /** Statement source without the terminating semicolon or surrounding comments. */
  readonly text: string;
  readonly tokens: readonly SqlToken[];
}

function isWord(token: SqlToken | undefined, ...words: string[]): boolean {
  return token?.kind === "word" && words.includes(token.value);
}

/**
 * Splits SQL into statements at top-level semicolons. `CREATE TRIGGER … BEGIN … END` bodies are
 * one statement, including semicolons inside the body and nested `CASE … END` expressions.
 */
export function splitSqlStatements(sql: string): SqlStatementText[] {
  const statements: SqlStatementText[] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  let bodyStarted = false;

  const isTrigger = (tokens: readonly SqlToken[]) =>
    isWord(tokens[0], "CREATE") &&
    (isWord(tokens[1], "TRIGGER") ||
      (isWord(tokens[1], "TEMP", "TEMPORARY") && isWord(tokens[2], "TRIGGER")));

  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) {
      statements.push({ text: sql.slice(first.start, last.end), tokens: current });
    }
    current = [];
    depth = 0;
    bodyStarted = false;
  };

  for (const token of tokenizeSql(sql)) {
    if (token.kind === "semicolon") {
      if (isTrigger(current) && (!bodyStarted || depth > 0)) {
        current.push(token);
        continue;
      }
      flush();
      continue;
    }
    current.push(token);
    if (isTrigger(current)) {
      if (isWord(token, "BEGIN", "CASE")) {
        if (token.value === "BEGIN") bodyStarted = true;
        depth += 1;
      } else if (isWord(token, "END")) {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  flush();
  return statements;
}

export type WriteOperation =
  | "insert"
  | "update"
  | "delete"
  | "replace"
  | "upsert_update"
  | "drop_table"
  | "drop_trigger"
  | "alter_table";

export interface WriteTarget {
  readonly operation: WriteOperation;
  /** Lower-cased table name (or trigger name for `drop_trigger`) without schema qualification. */
  readonly name: string;
}

export interface StatementAnalysis {
  /** Number of statements in the input text (1 for a well-formed batch entry). */
  readonly statementCount: number;
  /** Count of anonymous `?` placeholders. */
  readonly anonymousParameters: number;
  /** Named (`:x`, `@x`, `$x`) or numbered (`?1`) placeholders, which batch entries never use. */
  readonly otherParameters: readonly string[];
  /** Whether the statement starts with transaction control or `ATTACH`/`DETACH`. */
  readonly transactionControl: boolean;
  /** Whether the statement only reads (safe to retry at the transport level, §3.1). */
  readonly readOnly: boolean;
  readonly writeTargets: readonly WriteTarget[];
}

const transactionControlWords = [
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "ATTACH",
  "DETACH",
];
const writeWords = ["INSERT", "UPDATE", "DELETE", "REPLACE", "RETURNING"];

/** Reads a possibly schema-qualified name starting at `index`; returns the unqualified name. */
function readName(tokens: readonly SqlToken[], index: number): string | undefined {
  let position = index;
  let name: string | undefined;
  for (;;) {
    const token = tokens[position];
    if (!token || (token.kind !== "word" && token.kind !== "identifier")) return name;
    name = token.kind === "word" ? token.text.toLowerCase() : token.value.toLowerCase();
    const dot = tokens[position + 1];
    if (dot?.kind === "punctuation" && dot.text === ".") {
      position += 2;
      continue;
    }
    return name;
  }
}

function skipIfExists(tokens: readonly SqlToken[], index: number): number {
  return isWord(tokens[index], "IF") && isWord(tokens[index + 1], "EXISTS") ? index + 2 : index;
}

/** Finds the tables a statement writes, including `INSERT … ON CONFLICT DO UPDATE` targets. */
function findWriteTargets(tokens: readonly SqlToken[]): WriteTarget[] {
  const targets: WriteTarget[] = [];
  let insertTarget: string | undefined;
  const add = (operation: WriteOperation, name: string | undefined) => {
    if (name) targets.push({ operation, name });
  };

  tokens.forEach((token, index) => {
    if (token.kind !== "word") return;
    const previous = tokens[index - 1];
    switch (token.value) {
      case "INSERT": {
        let position = index + 1;
        if (isWord(tokens[position], "OR")) {
          if (isWord(tokens[position + 1], "REPLACE")) {
            // Handled when the REPLACE token itself is visited.
            return;
          }
          position += 2;
        }
        if (isWord(tokens[position], "INTO")) {
          insertTarget = readName(tokens, position + 1);
          add("insert", insertTarget);
        }
        return;
      }
      case "REPLACE": {
        if (isWord(tokens[index + 1], "INTO")) {
          const name = readName(tokens, index + 2);
          if (isWord(previous, "OR")) insertTarget = name;
          add("replace", name);
        }
        return;
      }
      case "UPDATE": {
        if (isWord(previous, "DO")) {
          add("upsert_update", insertTarget);
          return;
        }
        // `BEFORE UPDATE ON t`, `INSTEAD OF UPDATE` and `ON UPDATE` clauses name no write target.
        if (isWord(previous, "ON", "BEFORE", "AFTER", "OF")) return;
        let position = index + 1;
        if (isWord(tokens[position], "OR")) position += 2;
        add("update", readName(tokens, position));
        return;
      }
      case "DELETE": {
        if (isWord(previous, "ON")) return;
        if (isWord(tokens[index + 1], "FROM")) add("delete", readName(tokens, index + 2));
        return;
      }
      case "DROP": {
        if (isWord(tokens[index + 1], "TABLE")) {
          add("drop_table", readName(tokens, skipIfExists(tokens, index + 2)));
        } else if (isWord(tokens[index + 1], "TRIGGER")) {
          add("drop_trigger", readName(tokens, skipIfExists(tokens, index + 2)));
        }
        return;
      }
      case "ALTER": {
        if (isWord(tokens[index + 1], "TABLE")) add("alter_table", readName(tokens, index + 2));
        return;
      }
      default:
        return;
    }
  });
  return targets;
}

/** Lexical facts about one statement (or a text that turns out to hold several). */
export function analyzeStatement(sql: string): StatementAnalysis {
  const statements = splitSqlStatements(sql);
  const tokens = statements.flatMap((statement) => [...statement.tokens]);
  let anonymousParameters = 0;
  const otherParameters: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "parameter") continue;
    if (token.text === "?") anonymousParameters += 1;
    else otherParameters.push(token.text);
  }
  const first = tokens[0];
  const transactionControl =
    first?.kind === "word" && transactionControlWords.includes(first.value);
  const hasWriteWord = tokens.some(
    (token, index) =>
      token.kind === "word" &&
      writeWords.includes(token.value) &&
      // `replace(x, y, z)` is a scalar function, not `REPLACE INTO`.
      !(token.value === "REPLACE" && tokens[index + 1]?.text === "("),
  );
  const leading = first?.kind === "word" ? first.value : "";
  const readOnly =
    statements.length === 1 &&
    !hasWriteWord &&
    (leading === "SELECT" || leading === "VALUES" || leading === "WITH" || leading === "EXPLAIN");
  return {
    statementCount: statements.length,
    anonymousParameters,
    otherParameters,
    transactionControl,
    readOnly,
    writeTargets: findWriteTargets(tokens),
  };
}
