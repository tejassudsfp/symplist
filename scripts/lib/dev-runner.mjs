// Runs a dev plan (scripts/lib/dev-plan.mjs): the one-off build, then every long-running command
// with prefixed output, until a signal or a failure stops them all.
import { join } from "node:path";
import { commandFor, ProcessGroup, StartupError, waitUntilReady } from "./processes.mjs";

/** How long each command may take to become ready before startup counts as failed. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
/** How long commands get to exit after SIGINT or SIGTERM before they are killed. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** What to check when a command fails to start. */
const startupHints = {
  api: "check apps/api/.env: copy apps/api/.env.example and fill the secret families with pnpm secrets:generate",
  trigger:
    "check the Trigger.dev login (pnpm --filter @symplist/worker exec trigger login) and apps/worker/.env",
};

/**
 * Runs `plan` from `root` and resolves with the process exit code:
 * - the build's exit code when the one-off build fails (nothing else starts);
 * - the failing command's exit code (or 1) when a command fails to start or later stops on its own,
 *   after stopping every other command;
 * - 0 when SIGINT or SIGTERM stopped everything within the grace period, 1 when something had to be
 *   killed. A second signal kills every process group at once.
 */
export async function runDev({
  root,
  plan,
  output = process.stdout,
  color,
  signals = process,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}) {
  const names = [
    "dev",
    ...(plan.build ? [plan.build.name] : []),
    ...plan.processes.map((p) => p.name),
  ];
  const group = new ProcessGroup({ names, output, ...(color === undefined ? {} : { color }) });

  // Resolve every binary first, so a missing package fails before anything starts.
  const buildCommand = plan.build ? commandFor(root, plan.build.tool, plan.build.args) : undefined;
  const commands = plan.processes.map((spec) => commandFor(root, spec.tool, spec.args));

  let shutdown;
  let signalled = false;
  let notifySignal;
  const signal = new Promise((settle) => {
    notifySignal = settle;
  });

  const stopEverything = (message, stopSignal, failureCode) => {
    if (!shutdown) {
      group.log("dev", message);
      shutdown = group
        .stopAll(stopSignal, shutdownTimeoutMs)
        .then((clean) => failureCode ?? (clean ? 0 : 1));
    }
    return shutdown;
  };

  const onSignal = (name) => {
    if (signalled || shutdown) {
      group.log("dev", `${name} again: killing every process`);
      group.killAll();
      return;
    }
    signalled = true;
    notifySignal({ kind: "signal", name });
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", onSigterm);
  const stopOnSignal = ({ name }) => stopEverything(`${name} received: stopping`, name);

  try {
    if (plan.build) {
      const { name, cwd } = plan.build;
      const tool = plan.build.tool === "node" ? "node" : plan.build.tool.bin;
      group.log("dev", `${name}: ${tool} ${plan.build.args.join(" ")}`);
      const build = group.start({ name, ...buildCommand, cwd: join(root, cwd) });
      const result = await Promise.race([
        build.exit.then((exit) => ({ kind: "exit", ...exit })),
        signal,
      ]);
      if (result.kind === "signal") return await stopOnSignal(result);
      if (result.code !== 0) {
        group.log("dev", `${name} failed, so nothing else was started`);
        return result.code ?? 1;
      }
    }

    const started = plan.processes.map((spec, index) => ({
      spec,
      managed: group.start({
        name: spec.name,
        ...commands[index],
        cwd: join(root, spec.cwd),
        ...(spec.env === undefined ? {} : { env: { ...process.env, ...spec.env } }),
        ...(spec.shutdown === undefined ? {} : { shutdown: spec.shutdown }),
      }),
    }));

    const startup = Promise.all(
      started.map(({ spec, managed }) =>
        waitUntilReady(managed, {
          ready: spec.ready,
          failedStartup: spec.failedStartup,
          timeoutMs: startupTimeoutMs,
        }).catch((error) => {
          throw Object.assign(error, { processName: spec.name });
        }),
      ),
    );
    const outcome = await Promise.race([
      startup.then(
        () => ({ kind: "ready" }),
        (error) => ({ kind: "failed", error }),
      ),
      signal,
    ]);
    if (outcome.kind === "signal") return await stopOnSignal(outcome);
    if (outcome.kind === "failed") {
      if (!(outcome.error instanceof StartupError)) throw outcome.error;
      group.log("dev", outcome.error.message);
      const hint = startupHints[outcome.error.processName];
      if (hint) group.log("dev", hint);
      return await stopEverything("stopping every process", "SIGTERM", outcome.error.exitCode ?? 1);
    }

    const addresses = plan.processes.flatMap((spec) =>
      spec.ready.url === undefined ? [] : [`${spec.name} ${spec.ready.url}`],
    );
    group.log("dev", `ready${addresses.length > 0 ? `: ${addresses.join(", ")}` : ""}`);

    const ended = await Promise.race([
      ...started.map(({ spec, managed }) =>
        managed.exit.then((result) => ({ kind: "exit", spec, result })),
      ),
      signal,
    ]);
    if (ended.kind === "signal") return await stopOnSignal(ended);
    const { spec, result } = ended;
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    return await stopEverything(
      `${spec.name} stopped (${how}), so every other process is stopping`,
      "SIGTERM",
      result.code === 0 || result.code === null ? 1 : result.code,
    );
  } finally {
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
    if (!shutdown) await group.stopAll("SIGTERM", shutdownTimeoutMs);
  }
}
