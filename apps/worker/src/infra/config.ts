import { ConfigError } from "@symplist/config";
import { loadWorkerConfig, type WorkerConfig } from "@symplist/config/worker";
import { WorkerError } from "./errors.ts";

/**
 * Loads and validates the worker environment (§4.5, §16.1). A `ConfigError` names variables and rules
 * only; it is rethrown as `config.invalid` so no configuration detail reaches Trigger's error records,
 * while the affected variable names are logged for operators. Values and validation messages never
 * reach Trigger's run error records.
 */
export function loadWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  try {
    return loadWorkerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError || (error instanceof Error && error.name === "ConfigError")) {
      const variables =
        error instanceof ConfigError
          ? [...new Set(error.issues.map((issue) => issue.variable))]
          : [];
      console.error("worker configuration invalid", { variables });
      throw new WorkerError("config.invalid");
    }
    throw error;
  }
}
