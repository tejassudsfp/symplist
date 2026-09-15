// Child process supervision shared by scripts/dev.mjs, scripts/smoke-local.mjs and
// scripts/check-api-deploy.mjs: package binary resolution, prefixed and colored output, readiness
// probes, and shutdown that reaches every process a command started.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

/** The repository root (this file lives in scripts/lib). */
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A process that could not start or stopped while it was starting. */
export class StartupError extends Error {
  name = "StartupError";

  constructor(message, { exitCode } = {}) {
    super(message);
    this.exitCode = exitCode;
  }
}

const posix = process.platform !== "win32";
const palette = [36, 35, 33, 32, 34, 31];

/** Whether to color prefixes: a terminal, unless NO_COLOR is set; FORCE_COLOR forces it on. */
export function colorEnabled(stream, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(stream.isTTY);
}

/**
 * The JavaScript file behind a package binary (for example `tsc` in `typescript`), resolved the way
 * Node resolves the package from `fromDir`, so the workspace's pinned version runs.
 */
export function resolvePackageBin(fromDir, packageName, binName) {
  const require = createRequire(join(resolve(fromDir), "package.json"));
  let manifestPath;
  try {
    manifestPath = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new StartupError(
      `${packageName} is not installed for ${fromDir}; run pnpm install --frozen-lockfile`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (typeof bin !== "string") {
    throw new StartupError(`${packageName} has no "${binName}" binary`);
  }
  return join(dirname(manifestPath), bin);
}

/** The executable and arguments for a plan command (see scripts/lib/dev-plan.mjs). */
export function commandFor(root, tool, args) {
  if (tool === "node") return { file: process.execPath, args: [...args] };
  const bin = resolvePackageBin(join(root, tool.from), tool.package, tool.bin);
  return { file: process.execPath, args: [bin, ...args] };
}

/** Whether a whole process group (or, on Windows, the process) still exists. */
function groupAlive(pid) {
  try {
    process.kill(posix ? -pid : pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(posix ? -pid : pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

const delay = (ms) => new Promise((settle) => setTimeout(settle, ms));

/** Waits for `promise` for at most `ms`, without keeping the event loop alive afterwards. */
async function waitAtMost(promise, ms) {
  let timer;
  try {
    const timeout = new Promise((settle) => {
      timer = setTimeout(settle, ms);
    });
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One supervised child: its output is split into lines, prefixed and passed to listeners. */
export class ManagedProcess {
  #listeners = new Set();
  #exitResult;

  constructor({ name, file, args, cwd, env, write, prefix }) {
    this.name = name;
    // Each child leads its own process group, so a signal reaches everything it started
    // (for example the native tsc binary or the server next dev forks).
    this.child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
    });
    this.exit = new Promise((settle) => {
      this.child.once("error", (error) => {
        write(`${prefix}failed to start: ${error.message}\n`);
        this.#exitResult = { code: null, signal: null, error };
        settle(this.#exitResult);
      });
      // "exit", not "close": a grandchild that keeps the output pipes open must not hide the exit.
      this.child.once("exit", (code, signal) => {
        this.#exitResult ??= { code, signal };
        settle(this.#exitResult);
      });
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) this.#emit(line, write, prefix);
      });
      stream.on("end", () => {
        if (pending !== "") this.#emit(pending, write, prefix);
        pending = "";
      });
    }
  }

  #emit(line, write, prefix) {
    write(`${prefix}${line}\n`);
    const plain = stripVTControlCharacters(line);
    for (const listener of this.#listeners) listener(plain);
  }

  /** Calls `listener` with every later output line, without terminal control sequences. */
  onLine(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whether the child has exited. */
  get exited() {
    return this.#exitResult !== undefined;
  }

  get exitResult() {
    return this.#exitResult;
  }

  /** Whether SIGKILL was ever sent, so the process could not shut down cleanly. */
  killed = false;

  /** Sends a signal to the child's whole process group. */
  signal(signal) {
    if (signal === "SIGKILL") this.killed = true;
    if (this.child.pid !== undefined) signalGroup(this.child.pid, signal);
  }

  /**
   * Stops the child and anything it started: `signal` first, then SIGKILL for whatever is still
   * running after `timeoutMs`. Resolves with whether everything stopped without SIGKILL.
   */
  async stop(signal = "SIGTERM", timeoutMs = 10_000) {
    const pid = this.child.pid;
    if (pid === undefined) return !this.killed;
    const deadline = Date.now() + timeoutMs;
    if (!this.exited || groupAlive(pid)) signalGroup(pid, signal);
    await waitAtMost(this.exit, timeoutMs);
    while (groupAlive(pid) && Date.now() < deadline) await delay(50);
    if (!this.exited || groupAlive(pid)) {
      this.signal("SIGKILL");
      await this.exit;
      // Killed processes whose parent already exited are reaped by init shortly afterwards.
      const reapDeadline = Date.now() + 2_000;
      while (groupAlive(pid) && Date.now() < reapDeadline) await delay(20);
    }
    return !this.killed;
  }
}

/** Starts named processes with aligned, colored prefixes and stops them together. */
export class ProcessGroup {
  #processes = [];

  constructor({ names, output = process.stdout, color = colorEnabled(output) }) {
    this.width = Math.max(...names.map((name) => name.length));
    this.output = output;
    this.color = color;
    this.names = names;
  }

  prefix(name) {
    const label = name.padEnd(this.width);
    if (!this.color) return `${label} | `;
    const code = palette[Math.max(0, this.names.indexOf(name)) % palette.length];
    return `\u001b[${code}m${label}\u001b[0m | `;
  }

  /** Writes a line under a label, for messages from the supervisor itself. */
  log(name, message) {
    this.output.write(`${this.prefix(name)}${message}\n`);
  }

  /**
   * Starts `file args` in `cwd` with `env` (default: this process's environment). `shutdown`
   * overrides how `stopAll` treats this process: `timeoutMs` shortens its grace period, and
   * `killIsClean` means a SIGKILL after that grace period is an expected way to stop it.
   */
  start({ name, file, args, cwd, env = process.env, shutdown = {} }) {
    const managed = new ManagedProcess({
      name,
      file,
      args,
      cwd,
      env: this.color && env.FORCE_COLOR === undefined ? { ...env, FORCE_COLOR: "1" } : env,
      write: (text) => this.output.write(text),
      prefix: this.prefix(name),
    });
    this.#processes.push({ managed, shutdown });
    return managed;
  }

  get processes() {
    return this.#processes.map((entry) => entry.managed);
  }

  /**
   * Stops every process in parallel; resolves with whether all stopped cleanly (without SIGKILL,
   * unless the process was started with `shutdown.killIsClean`).
   */
  async stopAll(signal = "SIGTERM", timeoutMs = 10_000) {
    const results = await Promise.all(
      this.#processes.map(async ({ managed, shutdown }) => {
        const clean = await managed.stop(
          signal,
          Math.min(timeoutMs, shutdown.timeoutMs ?? timeoutMs),
        );
        return clean || shutdown.killIsClean === true;
      }),
    );
    return results.every(Boolean);
  }

  /** Sends SIGKILL to every process group at once. */
  killAll() {
    for (const { managed } of this.#processes) managed.signal("SIGKILL");
  }
}

/**
 * Resolves when `managed` is ready: an output line matches `ready.output`, or `ready.url` answers
 * (any HTTP status when `ready.anyStatus`, otherwise 2xx). Rejects with a StartupError when the
 * process exits first, prints a `failedStartup` line, or `timeoutMs` passes.
 */
export function waitUntilReady(managed, { ready, failedStartup, timeoutMs, pollMs = 250 }) {
  return new Promise((settleReady, fail) => {
    let settled = false;
    const cleanups = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      if (error) fail(error);
      else settleReady();
    };

    const timer = setTimeout(
      () =>
        finish(
          new StartupError(
            `${managed.name} was not ready within ${Math.round(timeoutMs / 1000)} s`,
          ),
        ),
      timeoutMs,
    );
    cleanups.push(() => clearTimeout(timer));

    void managed.exit.then((result) => {
      const how = result.error
        ? result.error.message
        : result.signal
          ? `signal ${result.signal}`
          : `exit code ${result.code}`;
      finish(
        new StartupError(`${managed.name} stopped while starting (${how})`, {
          exitCode: result.code === 0 || result.code === null ? 1 : result.code,
        }),
      );
    });

    cleanups.push(
      managed.onLine((line) => {
        if (failedStartup?.test(line)) {
          finish(new StartupError(`${managed.name} failed to start: ${line}`));
        } else if (ready.output?.test(line)) {
          finish();
        }
      }),
    );

    if (ready.url !== undefined) {
      let stopped = false;
      cleanups.push(() => {
        stopped = true;
      });
      const poll = async () => {
        while (!stopped) {
          try {
            const response = await fetch(ready.url, {
              redirect: "manual",
              signal: AbortSignal.timeout(Math.max(pollMs * 4, 1000)),
            });
            await response.body?.cancel();
            if (ready.anyStatus || response.ok) {
              finish();
              return;
            }
          } catch {
            // Not listening yet.
          }
          await delay(pollMs);
        }
      };
      void poll();
    }
  });
}
