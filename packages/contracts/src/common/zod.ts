import { z } from "zod";

/**
 * Zod, configured for the runtime it is loaded in, and the only place this package takes it from.
 *
 * The browser parses contracts schemas under the app's strict CSP, which carries no `unsafe-eval`
 * (§5.3, decision W1). Zod decides whether to compile a schema by probing `Function("")` inside a
 * try/catch: it recovers, but the browser still reports the attempt as a `script-src` violation, and
 * the shell's end-to-end check requires a page to raise none. Taking the interpreted path
 * deliberately makes the probe unnecessary. The api and the worker keep the compiled path.
 *
 * The choice is made on the first schema construction, so it has to be settled *before* any schema
 * module is evaluated. Ordering the barrel's exports is not enough — a bundler concatenates modules
 * in import order, not export order — so every schema module imports `z` from here, and
 * `zod-imports.test.ts` fails if one goes back to importing it directly.
 */
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  z.config({ jitless: true });
}

/** Whether schema compilation is disabled in this runtime. Exported so the choice is testable. */
export function schemaCompilationDisabled(): boolean {
  return z.config().jitless === true;
}

export { z };
