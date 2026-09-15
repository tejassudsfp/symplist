import { ConfigError } from "@symplist/config";
import { loadWorkerConfig, type WorkerConfig } from "@symplist/config/worker";
import { WorkerError } from "./errors.ts";

/**
 * Loads and validates the worker environment (§4.5, §16.1). A `ConfigError` names variables and rules
 * only; it is rethrown as `config.invalid` so no configuration detail reaches Trigger's error records,
 * and the issue variable names are returned to the caller for its own redacted log.
 */
export function loadWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  try {
    return loadWorkerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError || (error instanceof Error && error.name === "ConfigError")) {
      throw new WorkerError("config.invalid");
    }
    throw error;
  }
}
