/**
 * The main process log: stable dotted event codes with id, count and flag fields, matching the shape
 * the api and worker use (`packages/core/src/search/log.ts`). Fields never carry document text, task
 * titles, tokens or keys.
 *
 * `redactSecrets` exists for the one stream where free text is unavoidable: a child process's stderr.
 * The Next standalone server writes there today and the dsh harness will later, and a harness that
 * echoes a failed request back with its `Authorization` header would otherwise put a bearer token in
 * a file on disk. Redaction is a net, not a guarantee — nothing may be logged that only redaction
 * keeps safe.
 */

/** Log field values: ids, stable codes, counts, durations and flags only. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface MainLog {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A line of a child process's output, redacted and attributed to that child. */
  child(source: string, line: string): void;
}

/**
 * Each pattern names its own replacement, so a credential never survives as part of the marker. The
 * replacements keep the shape of the line — which scheme, which variable — and nothing of the value.
 */
const secretPatterns: readonly { readonly pattern: RegExp; readonly replacement: string }[] =
  Object.freeze([
    // Authorization headers, however they are spelled. The scheme stays; the credential does not.
    { pattern: /\b(bearer|basic)\s+[\w\-._~+/]+=*/gi, replacement: "$1 [redacted]" },
    // Our own encrypted envelopes, and provider key shapes (OpenAI `sk-`, Anthropic `sk-ant-`).
    { pattern: /\bsym1[A-Za-z0-9\-_.]{8,}/g, replacement: "[redacted]" },
    { pattern: /\bsk-[A-Za-z0-9\-_]{8,}/g, replacement: "[redacted]" },
    // `key: value` and `key=value` for anything that names itself a credential.
    {
      pattern:
        /\b([\w-]*(?:api[-_]?key|token|secret|password|credential)s?)(["']?\s*[:=]\s*["']?)([^\s"',;)}\]]+)/gi,
      replacement: "$1$2[redacted]",
    },
  ]);

/** Replaces credential-shaped substrings with a marker, preserving the surrounding text. */
export function redactSecrets(line: string): string {
  let redacted = line;
  for (const { pattern, replacement } of secretPatterns) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/** The log every main-process module takes as a dependency, so tests can pass a silent one. */
export function createMainLog(write: (line: string) => void = console.error): MainLog {
  const emit = (level: string, event: string, fields?: LogFields): void => {
    write(JSON.stringify({ level, event, ...fields }));
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (source, line) => {
      const trimmed = line.trimEnd();
      if (trimmed.length === 0) return;
      write(
        JSON.stringify({
          level: "info",
          event: "child.output",
          source,
          line: redactSecrets(trimmed),
        }),
      );
    },
  };
}

/** A log that discards everything. */
export const silentMainLog: MainLog = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => undefined,
});
