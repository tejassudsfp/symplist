import type { BuildExtension } from "@trigger.dev/build";

/**
 * Build-time helpers for `trigger.config.ts` only. Never imported by a task: `@trigger.dev/build` is a
 * development dependency and these functions run in the Trigger CLI at deploy time.
 */

/** A variable `syncEnvVars` uploads. */
export interface SyncedVariable {
  readonly name: string;
  readonly value: string;
  readonly isSecret: boolean;
}

export interface GuardedSyncIo {
  /** Prints a configuration problem: variable names and rules, never values. */
  readonly report: (message: string) => void;
  readonly exit: (code: number) => never;
}

const defaultIo: GuardedSyncIo = {
  report: (message) => process.stderr.write(`${message}\n`),
  exit: (code) => process.exit(code),
};

/**
 * Wraps the allowlist selection for `syncEnvVars`. Trigger.dev catches errors thrown inside the
 * callback and only warns, which would deploy without syncing; a `ConfigError` (or any other failure)
 * instead prints its message, which names variables and rules but never values, and exits non-zero.
 */
export function guardedSyncEnvVars(
  select: () => SyncedVariable[],
  io: GuardedSyncIo = defaultIo,
): () => SyncedVariable[] {
  return () => {
    try {
      return select();
    } catch (error) {
      const isConfigError = error instanceof Error && error.name === "ConfigError";
      io.report(
        isConfigError
          ? (error as Error).message
          : "syncEnvVars failed: the worker environment could not be selected",
      );
      return io.exit(1);
    }
  };
}

/**
 * Bakes fixed `ENV` instructions into the deployed image and registers the same values with
 * Trigger's deployment environment. Trigger's task runner replaces the image environment at run
 * startup, so the image instruction alone does not reach the task process. `syncEnvVars` drops
 * every `TRIGGER_*` name, making the deployment layer necessary for this setting.
 */
export function imageEnvExtension(instructions: readonly string[]): BuildExtension {
  const deployEnv: Record<string, string> = {};
  for (const instruction of instructions) {
    if (!/^ENV [A-Z][A-Z0-9_]*=[A-Za-z0-9._-]*$/.test(instruction)) {
      throw new Error("Image env instructions must be plain ENV NAME=value lines");
    }
    const [name, value] = instruction.slice(4).split("=");
    if (name && value !== undefined) deployEnv[name] = value;
  }
  return {
    name: "symplist-image-env",
    onBuildComplete(context) {
      if (context.target === "dev") return;
      context.addLayer({
        id: "symplist-image-env",
        image: { instructions: [...instructions] },
        deploy: { env: deployEnv, override: true },
      });
    },
  };
}
