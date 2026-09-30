/**
 * The renderer's origin: the existing apps/web frontend, running as a Next standalone server on
 * 127.0.0.1 inside the app.
 *
 * Re-hosting 39k lines of frontend was the alternative, and it buys nothing a user can see, so the
 * desktop keeps the Next server and spends phase 2's budget on the assistant instead. Two consequences
 * are load-bearing and must survive later edits:
 *
 *   1. The listener is local, and any process on the machine — or a remote page via DNS rebinding —
 *      can reach it. It is safe only because it is **dataless**: the renderer holds no session, no
 *      cookie and no key, and every byte of cloud traffic goes through the main process instead. Put
 *      the session back in the renderer and this becomes a real hole.
 *   2. The child gets an explicitly built environment, not `process.env`. Main will hold the model
 *      provider key and the MCP bearer key in memory; inheriting them into an SSR process that never
 *      needs either is how a secret ends up in a stack trace.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { MainLog } from "./log.ts";

/** A booted renderer origin and the way to shut it down. */
export interface RendererServer {
  readonly origin: string;
  stop(): Promise<void>;
}

/**
 * The Next standalone entry point under a staged web directory. Next writes a monorepo build to
 * `<root>/apps/web/server.js` and a single-package build to `<root>/server.js`; both are accepted so a
 * change to the web app's position in the workspace does not become a desktop bug.
 */
export function resolveStandaloneEntry(root: string): string | null {
  for (const candidate of [join(root, "apps", "web", "server.js"), join(root, "server.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A free TCP port on the loopback interface. Next's standalone server binds the port it is given, so
 * the port is reserved here and released immediately; the window between release and bind is a race we
 * accept in exchange for knowing the origin before the server starts.
 */
export function reserveLoopbackPort(hostname = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, hostname, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("loopback port probe returned no address")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Options for `waitForHttpReady`, all injectable so the wait is tested against a real local server. */
export interface WaitForHttpReadyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolves once the origin answers anything at all. A redirect counts: a signed-out desktop is sent to
 * /signin by the Next proxy, and that is a served page, not a failure.
 */
export async function waitForHttpReady(
  origin: string,
  options: WaitForHttpReadyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await fetchImpl(origin, { method: "GET", redirect: "manual" });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`renderer server did not answer at ${origin} within ${timeoutMs}ms`, {
          cause: error,
        });
      }
      await sleep(intervalMs);
    }
  }
}

/** Options for booting the staged Next standalone server. */
export interface StartRendererServerOptions {
  /** The staged web directory: `<resources>/web` when packaged, `build/web` when not. */
  readonly root: string;
  readonly log: MainLog;
  readonly hostname?: string;
  /**
   * The executable that runs the server. In Electron this is `process.execPath` with
   * `ELECTRON_RUN_AS_NODE`, so the app ships one Node runtime rather than two.
   */
  readonly nodePath?: string;
  readonly timeoutMs?: number;
}

/**
 * The environment the SSR child runs with. Built from a fixed list rather than inherited: see the
 * module comment. `NEXT_PUBLIC_*` values are already inlined at build time, so nothing the frontend
 * needs is missing here.
 */
function childEnv(port: number, hostname: string): NodeJS.ProcessEnv {
  const passthrough = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "TEMP", "TMP"];
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOSTNAME: hostname,
  };
  for (const name of passthrough) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Boots the staged frontend and resolves once it serves. The caller creates the window only after
 * this resolves, so the user never sees an empty frame waiting for a port to bind.
 */
export async function startRendererServer(
  options: StartRendererServerOptions,
): Promise<RendererServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const entry = resolveStandaloneEntry(options.root);
  if (!entry) {
    throw new Error(
      `no Next standalone server under ${options.root}: run "pnpm --filter @symplist/desktop build:web", which builds apps/web with SYMPLIST_DESKTOP=1`,
    );
  }

  const port = await reserveLoopbackPort(hostname);
  const origin = `http://${hostname}:${port}`;
  const started = Date.now();
  const child = spawn(options.nodePath ?? process.execPath, [entry], {
    cwd: join(entry, ".."),
    env: childEnv(port, hostname),
    stdio: ["ignore", "pipe", "pipe"],
  });

  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) options.log.child("renderer", line);
    });
  }

  let exited = false;
  child.once("exit", (code, signal) => {
    exited = true;
    options.log.warn("renderer.exited", { code: code ?? null, signal: signal ?? null });
  });

  const stop = async (): Promise<void> => {
    if (exited || child.pid === undefined) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    await waitForHttpReady(origin, { timeoutMs: options.timeoutMs ?? 30_000 });
  } catch (error) {
    await stop();
    throw error;
  }
  options.log.info("renderer.ready", { durationMs: Date.now() - started });
  return { origin, stop };
}
