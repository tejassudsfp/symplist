/** Where a marker string was found inside a recorded value. */
export interface MarkerLocation {
  /** JSON-path-like location, for example `payload.messages[0].text` or `error.stack`. */
  readonly path: string;
}

/**
 * Finds every place `marker` occurs in a value: string leaves, object keys, `Error` names, messages,
 * stacks and causes, `Date` values, Maps, Sets and typed-array bytes decoded as UTF-8. Used by
 * marker-string leak tests (§8.3) to prove content never reaches a sink.
 */
export function findMarkerIn(value: unknown, marker: string, root = "$"): MarkerLocation[] {
  if (marker === "") throw new Error("A marker must not be empty");
  const found: MarkerLocation[] = [];
  const seen = new WeakSet<object>();

  const visit = (current: unknown, path: string): void => {
    if (current === null || current === undefined) return;
    if (typeof current === "string") {
      if (current.includes(marker)) found.push({ path });
      return;
    }
    if (
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "bigint"
    ) {
      if (String(current).includes(marker)) found.push({ path });
      return;
    }
    if (typeof current === "function" || typeof current === "symbol") return;
    if (typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);

    if (current instanceof Date) {
      visit(current.toISOString(), path);
      return;
    }
    if (current instanceof Error) {
      visit(current.name, `${path}.name`);
      visit(current.message, `${path}.message`);
      visit(current.stack, `${path}.stack`);
      visit((current as { cause?: unknown }).cause, `${path}.cause`);
    }
    if (ArrayBuffer.isView(current)) {
      const bytes = new Uint8Array(current.buffer, current.byteOffset, current.byteLength);
      visit(new TextDecoder().decode(bytes), path);
      return;
    }
    if (current instanceof ArrayBuffer) {
      visit(new TextDecoder().decode(new Uint8Array(current)), path);
      return;
    }
    if (current instanceof Map) {
      for (const [key, entry] of current) {
        visit(key, `${path}{key}`);
        visit(entry, `${path}[${String(key)}]`);
      }
      return;
    }
    if (current instanceof Set) {
      let index = 0;
      for (const entry of current) {
        visit(entry, `${path}{${index}}`);
        index += 1;
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => {
        visit(entry, `${path}[${index}]`);
      });
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (key.includes(marker)) found.push({ path: `${path}{${key}}` });
      visit(entry, `${path}.${key}`);
    }
  };

  visit(value, root);
  return found;
}
